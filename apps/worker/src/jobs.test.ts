import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Docker } from "./docker.ts"
import { backupJob, exportCredentialsJob } from "./jobs.ts"

const bin = mkdtempSync(join(tmpdir(), "export-"))
const left = () =>
  readdirSync("/tmp")
    .filter((name) => name.startsWith("n8n-ops-export"))
    .map((name) => join("/tmp", name))
const secret = randomBytes(16).toString("hex")
const stored = [
  { id: "c1", name: "ERP", type: "httpHeaderAuth", data: { value: secret } },
  { id: "c2", name: "Mail", type: "smtp", data: { password: secret } },
]

const docker = {
  exec: async (_container: string, cmd: string[]) => {
    const [command = "", ...args] = cmd
    const ran = spawnSync(command, args, { env: { PATH: `${bin}:${process.env.PATH}` } })
    return { exitCode: ran.status ?? -1, stdout: ran.stdout, stderr: ran.stderr.toString() }
  },
} as unknown as Docker

function n8n(script: string) {
  writeFileSync(join(bin, "n8n"), `#!/bin/sh\n${script}\n`)
  chmodSync(join(bin, "n8n"), 0o755)
}
const writes = (text: string) =>
  `for a in "$@"; do case "$a" in --output=*) printf '%s' '${text}' > "\${a#--output=}" ;; esac; done`

const run = (ids: string[] | null = null) => exportCredentialsJob(docker, { container: "n8n", ids })

beforeEach(() => {
  for (const path of left()) rmSync(path, { recursive: true, force: true })
})
afterAll(() => rmSync(bin, { recursive: true, force: true }))

describe("the credential export", () => {
  it("returns what n8n exported, all of it or the ids asked for, and leaves no file behind", async () => {
    n8n(`echo "Successfully exported 2 credentials."\n${writes(JSON.stringify(stored))}`)
    expect(await run()).toEqual({ ok: true, result: { credentials: stored, empty: false } })
    expect(await run(["c2"])).toEqual({ ok: true, result: { credentials: [stored[1]], empty: false } })
    expect(left()).toEqual([])
  })

  it("fails when n8n fails, and repeats nothing n8n printed", async () => {
    n8n(`echo "Error: could not decrypt ${secret}" >&2\nexit 1`)
    const result = await run()
    expect(result).toMatchObject({ ok: false })
    expect(result.result).toBeUndefined()
    expect(result.error).toMatch(/^credential export failed: n8n export:credentials failed in n8n \(exit code 1\)/)
    expect(result.error).not.toContain(secret)
  })

  it("fails when n8n ends well without writing a file", async () => {
    n8n("exit 0")
    expect(await run()).toMatchObject({ ok: false })
  })

  it("fails on a file that is not JSON, without repeating it", async () => {
    n8n(writes(`x${secret}`))
    const result = await run()
    expect(result).toMatchObject({ ok: false })
    expect(result.error).not.toContain(secret.slice(0, 4))
  })

  it("says so when n8n has no credentials", async () => {
    n8n(
      '[ "$N8N_LOG_OUTPUT" = console ] && [ "$N8N_LOG_LEVEL" = error ] && [ "$N8N_LOG_FORMAT" = text ] && echo "No credentials found with specified filters"\nexit 1',
    )
    expect(await run()).toEqual({ ok: true, result: { credentials: [], empty: true } })
  })

  it("removes what a killed export left more than an hour ago, and nothing of one that runs now", async () => {
    const old = "/tmp/n8n-ops-export.tar"
    const now = mkdtempSync("/tmp/n8n-ops-export.")
    writeFileSync(old, secret)
    const own = "/tmp/n8n-ops-export.backup"
    writeFileSync(own, secret)
    for (const path of [old, own]) utimesSync(path, new Date(0), new Date(0))
    writeFileSync(join(now, "credentials.json"), secret)
    n8n(writes(JSON.stringify(stored)))
    expect(await run()).toMatchObject({ ok: true })
    expect([old, own].map((path) => existsSync(path))).toEqual([false, true])
    expect(existsSync(join(now, "credentials.json"))).toBe(true)
  })
})

describe("a worker stopped while n8n exports", () => {
  it.each([
    {
      job: "a credential export",
      start: (d: Docker) => exportCredentialsJob(d, { container: "n8n", ids: null }),
    },
    {
      job: "a backup",
      start: (d: Docker) =>
        backupJob(d, { container: "n8n", recipient: "age1x" }, async () => ({ url: "", headers: {} })),
    },
  ])("leaves no decrypted file of $job in the container", async ({ start }) => {
    n8n(
      `for a in "$@"; do case "$a" in
--output=*/credentials/) echo ${secret} > "\${a#--output=}c1.json" ;;
--output=*/) ;;
--output=*) echo ${secret} > "\${a#--output=}" ;;
esac; done
sleep 0.5
echo exported`,
    )
    let ended: Promise<unknown> | undefined
    const cut = {
      exec: (_container: string, [command = "", ...args]: string[]) => {
        const script = spawn(command, args, { env: { PATH: `${bin}:${process.env.PATH}` } })
        script.stdout.destroy()
        script.stderr.destroy()
        ended = new Promise((resolve) => script.on("close", resolve))
        return new Promise(() => {})
      },
    } as unknown as Docker
    void start(cut)
    await vi.waitFor(() => expect(left()).toHaveLength(1))
    await ended
    expect(left()).toEqual([])
  })
})

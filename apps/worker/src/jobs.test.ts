import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import type { Docker } from "./docker.ts"
import { exportCredentialsJob } from "./jobs.ts"

const bin = mkdtempSync(join(tmpdir(), "export-"))
const FILE = "/tmp/n8n-ops-export.json"
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

beforeEach(() => rmSync(FILE, { force: true }))
afterAll(() => rmSync(bin, { recursive: true, force: true }))

describe("the credential export", () => {
  it("returns what n8n exported, all of it or the ids asked for, and leaves no file behind", async () => {
    n8n(`echo "Successfully exported 2 credentials."\n${writes(JSON.stringify(stored))}`)
    expect(await run()).toEqual({ ok: true, result: { credentials: stored, empty: false } })
    expect(await run(["c2"])).toEqual({ ok: true, result: { credentials: [stored[1]], empty: false } })
    expect(existsSync(FILE)).toBe(false)
  })

  it("fails when n8n fails, whatever file an earlier run left, and repeats nothing n8n printed", async () => {
    writeFileSync(FILE, JSON.stringify(stored))
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

  it("says so when n8n has no credentials, whatever file an earlier run left", async () => {
    writeFileSync(FILE, JSON.stringify(stored))
    n8n(
      '[ "$N8N_LOG_OUTPUT" = console ] && [ "$N8N_LOG_LEVEL" = error ] && [ "$N8N_LOG_FORMAT" = text ] && echo "No credentials found with specified filters"\nexit 1',
    )
    expect(await run()).toEqual({ ok: true, result: { credentials: [], empty: true } })
  })
})

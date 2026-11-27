import { spawn } from "node:child_process"
import { rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DRAIN_FILE } from "./drain-file.ts"

const server = createServer((_req, res) => res.end("{}"))
let port = 0

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as { port: number }).port
})
afterAll(() => {
  server.close()
  rmSync(DRAIN_FILE, { force: true })
})

const check = () =>
  new Promise<number | null>((resolve) =>
    spawn(process.execPath, [join(import.meta.dirname, "healthcheck.ts")], {
      env: { ...process.env, PORT: String(port) },
    }).on("exit", resolve),
  )

describe("the health check", () => {
  it("passes while the server answers, and fails once the server drains before it stops", async () => {
    rmSync(DRAIN_FILE, { force: true })
    expect(await check()).toBe(0)
    writeFileSync(DRAIN_FILE, "")
    expect(await check()).toBe(1)
  })
})

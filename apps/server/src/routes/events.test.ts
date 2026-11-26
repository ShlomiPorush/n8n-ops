import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import type { Ctx } from "../context.ts"
import { endStreams, eventRoutes } from "./events.ts"

vi.mock("../http/middleware.ts", () => ({
  requireUser: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("actor", { kind: "token", id: "t1", name: "test" })
    await next()
  },
}))

const ctx = { events: new EventEmitter(), log: { info() {}, warn() {}, error() {} } } as unknown as Ctx

async function read(res: Response) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text
    text += new TextDecoder().decode(value)
  }
}

describe("live updates of a server that stops", () => {
  it("end the open streams, and a stream opened after ends at once", async () => {
    const app = eventRoutes(ctx)
    const open = await app.request("/")
    const reader = (open.body as ReadableStream<Uint8Array>).getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain("event: ready")
    endStreams()
    await expect(
      Promise.race([
        (async () => {
          for (;;) if ((await reader.read()).done) return "ended"
        })(),
        new Promise((r) => setTimeout(() => r("still open"), 2000)),
      ]),
    ).resolves.toBe("ended")
    const late = await app.request("/")
    expect(await read(late)).not.toContain("event: ready")
  })
})

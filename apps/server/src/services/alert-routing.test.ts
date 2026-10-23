import { describe, expect, it } from "vitest"
import { sections, type TelegramRoute, telegramRouteSchema } from "../lib/settings.ts"
import { instanceSubject, resolveThread, routeMatches, sendRouted } from "./alert-routing.ts"
import { html, isMessageGone, isTopicGone, Telegram, TelegramError } from "./telegram.ts"

const A = "11111111-1111-4111-8111-111111111111"
const B = "22222222-2222-4222-8222-222222222222"

describe("topic routes", () => {
  const routes: TelegramRoute[] = [
    { instanceId: A, threadId: 16 },
    { workflow: "orders|leads|ÉQUIPE", threadId: 12 },
    { tag: "Finance", threadId: 18 },
    { instanceId: B, workflow: "^sync", threadId: 20 },
  ]
  const config = { routes, defaultThreadId: null }

  it("takes the first route whose every condition holds", () => {
    expect(resolveThread(config, { instanceId: A, workflowName: "Import leads" })).toBe(16)
    expect(resolveThread(config, { instanceId: B, workflowName: "Import leads" })).toBe(12)
    expect(resolveThread(config, { instanceId: B, workflowName: "Sync stock" })).toBe(20)
    expect(resolveThread(config, { workflowName: "Sync stock" })).toBeNull()
  })

  it("compares workflow names and tags without case, Unicode included", () => {
    expect(resolveThread(config, { instanceId: B, workflowName: "Rapport équipe" })).toBe(12)
    expect(resolveThread(config, { instanceId: B, workflowName: "x", tags: ["finance"] })).toBe(18)
    expect(resolveThread(config, { instanceId: B, workflowName: "x", tags: ["financial"] })).toBeNull()
  })

  it("never matches a workflow or tag route for an alert about an instance alone", () => {
    expect(routeMatches({ workflow: ".*", threadId: 1 }, instanceSubject(A))).toBe(false)
    expect(routeMatches({ tag: "x", threadId: 1 }, { instanceId: A })).toBe(false)
    expect(resolveThread({ routes, defaultThreadId: 99 }, instanceSubject(null))).toBe(99)
  })

  it("gives up on a pattern that takes too long, once, and ignores it from then on", () => {
    const slow: string[] = []
    const route = { workflow: "^(a+)+$", threadId: 1 }
    const name = `${"a".repeat(40)}!`
    const started = Date.now()
    expect(routeMatches(route, { workflowName: name }, (p) => slow.push(p))).toBe(false)
    expect(routeMatches(route, { workflowName: "aaa" }, (p) => slow.push(p))).toBe(false)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(slow).toEqual(["^(a+)+$"])
    // Other patterns still work in the same context.
    expect(routeMatches({ workflow: "^a+$", threadId: 1 }, { workflowName: "aaa" })).toBe(true)
  })
})

describe("route validation", () => {
  const ok = (r: unknown) => telegramRouteSchema.safeParse(r).success

  it("needs a condition, reading empty or blank fields as not set", () => {
    expect(ok({ threadId: 3 })).toBe(false)
    expect(ok({ workflow: "", tag: "  ", instanceId: "", threadId: 3 })).toBe(false)
    expect(ok({ workflow: " a ", threadId: 3 })).toBe(true)
    expect(telegramRouteSchema.parse({ workflow: " a ", tag: "", threadId: 3 })).toEqual({ workflow: "a", threadId: 3 })
  })

  it("refuses a pattern that does not compile, and topics outside a PostgreSQL integer", () => {
    expect(ok({ workflow: "(", threadId: 3 })).toBe(false)
    expect(ok({ workflow: "a", threadId: 0 })).toBe(false)
    expect(ok({ workflow: "a", threadId: 2_147_483_648 })).toBe(false)
    expect(ok({ workflow: "a", threadId: 2_147_483_647 })).toBe(true)
    expect(ok({ workflow: "a".repeat(201), threadId: 3 })).toBe(false)
  })

  it("takes null topics and at most 50 routes", () => {
    const base = { chatId: "-100", webhookSecret: "s", defaultThreadId: null, accessThreadId: null }
    expect(sections.telegram.safeParse({ ...base, routes: [] }).success).toBe(true)
    const many = Array.from({ length: 51 }, () => ({ tag: "x", threadId: 1 }))
    expect(sections.telegram.safeParse({ ...base, routes: many }).success).toBe(false)
  })
})

describe("sending into a topic", () => {
  function bot(answer: (body: Record<string, unknown>) => Record<string, unknown>) {
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      bodies.push(body)
      return new Response(JSON.stringify(answer(body)))
    }) as never
    return { bodies, api: new Telegram("t", fetchImpl) }
  }
  const sent = { ok: true, result: { message_id: 7 } }
  const render = (note?: unknown) => (note ? html`${String(note)}|text` : html`text`)

  it("posts with message_thread_id only when there is a topic", async () => {
    const { bodies, api } = bot(() => sent)
    await api.send("-100", html`hi`, [], 6259)
    await api.send("-100", html`hi`, [], null)
    await api.send("-100", html`hi`)
    expect(bodies.map((b) => b.message_thread_id)).toEqual([6259, undefined, undefined])
  })

  it("falls back to General once when the topic is gone", async () => {
    const { bodies, api } = bot((b) =>
      b.message_thread_id ? { ok: false, error_code: 400, description: "Bad Request: message thread not found" } : sent,
    )
    expect(await sendRouted(api, "-100", 42, render)).toEqual({ messageId: 7, threadId: null, fellBack: true })
    expect(bodies.map((b) => b.message_thread_id)).toEqual([42, undefined])
    expect(String(bodies[1]?.text)).toContain("Topic 42 was not found")
  })

  it("does not fall back on other refusals", async () => {
    for (const refusal of [
      { ok: false, error_code: 429, description: "Too Many Requests: retry after 5", parameters: { retry_after: 5 } },
      { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
      { ok: false, error_code: 403, description: "Forbidden: bot was kicked from the supergroup chat" },
    ]) {
      const { bodies, api } = bot(() => refusal)
      await expect(sendRouted(api, "-100", 42, render)).rejects.toBeInstanceOf(TelegramError)
      expect(bodies).toHaveLength(1)
    }
  })

  it("tells a gone topic and a gone message from other errors", () => {
    const e = (code: number, description: string) => new TelegramError("x", undefined, code, description)
    expect(isTopicGone(e(400, "Bad Request: message thread not found"))).toBe(true)
    expect(isTopicGone(e(400, "Bad Request: TOPIC_CLOSED"))).toBe(true)
    expect(isTopicGone(e(400, "Bad Request: chat not found"))).toBe(false)
    expect(isTopicGone(new Error("message thread not found"))).toBe(false)
    expect(isMessageGone(e(400, "Bad Request: message to edit not found"))).toBe(true)
    expect(isMessageGone(e(400, "Bad Request: message is not modified"))).toBe(false)
  })
})

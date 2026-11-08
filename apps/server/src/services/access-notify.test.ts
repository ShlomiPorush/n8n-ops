import { messageWriting } from "@n8n-ops/shared"
import { describe, expect, it } from "vitest"
import { accessOutcome, isApprover, renderAccessEmail, renderAccessTelegram } from "./access-notify.ts"
import { topicGoneNote } from "./alert-routing.ts"
import { TelegramHtml, telegramPlainText } from "./telegram.ts"

const request = {
  id: "3f2a9c10-0000-4000-8000-000000000001",
  instance: "flow",
  token: "claude-code",
  reason: "Fix the <Set> node in the ERP sync",
  scopes: ["workflow:read", "workflow:update"],
  workflowIds: ["w1"],
  minutes: 90,
  decideBy: new Date("2026-10-15T10:30:00Z"),
}

const zone = messageWriting({ timezone: "Asia/Jerusalem" })

/** Approved at 10:17:43 UTC for 90 minutes, nothing said and no calls yet. */
const approved = {
  status: "approved" as const,
  decidedAt: new Date("2026-10-21T10:17:43Z"),
  decidedBy: "telegram:@ShlomiMe",
  decidedVia: "telegram",
  expiresAt: new Date("2026-10-21T11:47:43Z"),
  endedAt: null as Date | null,
  minutes: 90,
  summary: null as string | null,
  callCount: 0,
  refusedCount: 0,
}

describe("who may approve in Telegram", () => {
  it("is anyone listed, by user ID or @username", () => {
    expect(isApprover(["123", "@Shlomi"], "-1001", { id: 123 })).toBe(true)
    expect(isApprover(["123", "@Shlomi"], "-1001", { id: 9, username: "shlomi" })).toBe(true)
    expect(isApprover(["123", "@Shlomi"], "-1001", { id: 9, username: "someone" })).toBe(false)
  })

  it("is only the user of a private chat when nobody is listed", () => {
    expect(isApprover([], "4242", { id: 4242 })).toBe(true)
    expect(isApprover([], "4242", { id: 999 })).toBe(false)
    // A group chat ID never matches a user, so nobody in a group may approve without a list.
    expect(isApprover([], "-1004242", { id: 4242 })).toBe(false)
    expect(isApprover([], "4242", undefined)).toBe(false)
  })
})

describe("request messages", () => {
  const outcome = (...args: Parameters<typeof accessOutcome>) => {
    const { icon, lines } = accessOutcome(...args)
    return { icon, lines: lines.map(String) }
  }

  it("show what is asked, escaped for Telegram, with the length in bold and when the request expires", () => {
    const text = String(renderAccessTelegram(request, zone))
    expect(text.startsWith("🔐 <b>Access request</b> · flow")).toBe(true)
    expect(text).toContain("Fix the &lt;Set&gt; node")
    expect(text).toContain("workflow:read, workflow:update")
    expect(text).toContain("\nWorkflow: <code>w1</code>\n")
    // The time has no zone after it (13:30 in Jerusalem, summer time).
    expect(text.endsWith("For <b>1 h 30 min</b>\nRequest expires at 15/10/2026 13:30")).toBe(true)
  })

  it("name the workflows without their IDs, one line each, and show an ID only when the name is not known", () => {
    const named = {
      ...request,
      workflowIds: ["w1", "w2", "toString"],
      workflowNames: { w1: "Sync <orders>", w2: "ERP import" },
    }
    const text = String(renderAccessTelegram(named, zone))
    expect(text).toContain("\nWorkflows:\n• Sync &lt;orders&gt;\n• ERP import\n• <code>toString</code>\nFor ")
    expect(String(renderAccessTelegram({ ...request, workflowNames: { w1: "Sync" } }, zone))).toContain(
      "\nWorkflow: Sync\n",
    )
    expect(String(renderAccessTelegram({ ...request, workflowIds: [] }, zone))).toContain(
      "\nWorkflows: the whole instance\n",
    )
    // The email keeps the IDs.
    const email = renderAccessEmail(named, null)
    expect(email.text).toContain("Workflows: Sync <orders> (w1), ERP import (w2), toString")
    expect(email.html).toContain("Sync &lt;orders&gt; (w1), ERP import (w2), toString")
  })

  it("stay within Telegram's 4096 characters with every field at its longest, and count what is left out", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `${i}`.padEnd(83, "w"))
    const long = {
      ...request,
      instance: "i".repeat(5000),
      token: "t".repeat(5000),
      reason: "r".repeat(500),
      scopes: Array.from({ length: 300 }, (_, i) => `scope:${i}`.padEnd(80, "s")),
      workflowIds: ids,
      workflowNames: Object.fromEntries(ids.map((id) => [id, "n".repeat(5000)])),
    }
    const released = {
      ...approved,
      status: "released" as const,
      decidedBy: "d".repeat(5000),
      decidedVia: "web",
      endedAt: new Date("2026-10-21T10:40:00Z"),
      summary: "s".repeat(1000),
      callCount: 123456,
      refusedCount: 12345,
    }
    const text = renderAccessTelegram(long, zone, accessOutcome(released, zone))
    const sent = TelegramHtml.join([topicGoneNote(2147483647), text])
    expect([...telegramPlainText(sent)].length).toBeLessThan(4096)
    expect(String(text)).toMatch(/<\/code> and \d+ more\nWorkflows:\n(• n+…\n)+• and \d+ more\nFor /)
    expect(String(text)).toContain(`\nWhat was done:\n${"s".repeat(499)}…\n`)

    // Only IDs, as a request made before names were stored.
    const unnamed = String(renderAccessTelegram({ ...long, workflowNames: {} }, zone, accessOutcome(released, zone)))
    expect([...telegramPlainText(unnamed)].length).toBeLessThan(4096)
    expect(unnamed).toMatch(/\nWorkflows:\n(• <code>\d+w+<\/code>\n)+• and \d+ more\n/)
  })

  it("show at a glance who decided where, and then how the access ended, how long it was used and what was done", () => {
    const text = String(renderAccessTelegram(request, zone, accessOutcome(approved, zone)))
    expect(text.startsWith("✅ <b>Access request</b>")).toBe(true)
    // Once decided, the request no longer says when it expires.
    expect(text).not.toContain("Request expires")
    expect(
      text.endsWith(
        "For <b>1 h 30 min</b>\n\n✅ <b>Approved</b> by @ShlomiMe via Telegram\nAccess until 21/10/2026 14:47",
      ),
    ).toBe(true)

    const ended = new Date("2026-10-21T10:40:30Z")
    expect(
      outcome(
        {
          ...approved,
          status: "released",
          endedAt: ended,
          summary: "Fixed the <Set> node.",
          callCount: 14,
          refusedCount: 2,
        },
        zone,
      ).lines,
    ).toEqual([
      "✅ <b>Approved</b> by @ShlomiMe via Telegram",
      "⏹ <b>Released</b> by the agent at 21/10/2026 13:40",
      "Used 22 min of 1 h 30 min",
      "",
      "What was done:",
      "Fixed the &lt;Set&gt; node.",
      "14 calls through n8n-ops, 2 refused",
    ])
    // Without a summary (expired, revoked, or an agent that gave none), only the calls.
    expect(
      outcome({ ...approved, status: "expired", endedAt: new Date("2026-10-21T11:48:10Z"), callCount: 1 }, zone).lines,
    ).toEqual([
      "✅ <b>Approved</b> by @ShlomiMe via Telegram",
      "⌛ <b>Access ended</b> at 21/10/2026 14:48",
      "Used 1 h 30 min of 1 h 30 min",
      "",
      "1 call through n8n-ops",
    ])
    expect(outcome({ ...approved, status: "revoked", endedAt: new Date("2026-10-21T10:18:00Z") }, zone).lines).toEqual([
      "✅ <b>Approved</b> by @ShlomiMe via Telegram",
      "⛔ <b>Revoked</b> at 21/10/2026 13:18",
      "Used under 1 min of 1 h 30 min",
      "",
      "No calls through n8n-ops",
    ])
    expect(outcome({ ...approved, status: "denied", decidedBy: "shlomi", decidedVia: "web" }, zone)).toEqual({
      icon: "❌",
      lines: ["❌ <b>Denied</b> by shlomi via n8n-ops"],
    })
    const undecided = { ...approved, decidedAt: null, decidedBy: null, decidedVia: null, expiresAt: null }
    expect(outcome({ ...undecided, status: "expired", endedAt: ended }, zone)).toEqual({
      icon: "⌛",
      lines: ["⌛ <b>Expired</b> without a decision"],
    })
    expect(outcome({ ...undecided, status: "released", endedAt: ended }, zone).lines).toEqual([
      "↩️ <b>Withdrawn</b> by the agent at 21/10/2026 13:40",
    ])
    // A name that looks like markup stays text.
    expect(outcome({ ...approved, decidedBy: "<b>x</b>", decidedVia: "web" }, messageWriting(undefined)).lines[0]).toBe(
      "✅ <b>Approved</b> by &lt;b&gt;x&lt;/b&gt; via n8n-ops",
    )
  })

  it("write times in the Date and Time format of Settings, without the zone", () => {
    const dates = messageWriting({ timezone: "Europe/Berlin", dateFormat: "YYYY-MM-DD", timeFormat: "12h" })
    expect(outcome({ ...approved, decidedBy: "shlomi", decidedVia: "web" }, dates).lines[1]).toBe(
      "Access until 2026-10-21 1:47 PM",
    )
  })

  it("link to the request in email when the public URL is known", () => {
    const withLink = renderAccessEmail(request, "https://ops.example.com/access/3f2a")
    expect(withLink.subject).toBe("n8n-ops: claude-code asks for access to flow")
    expect(withLink.text).toContain("https://ops.example.com/access/3f2a")
    expect(withLink.html).toContain('href="https://ops.example.com/access/3f2a"')
    expect(withLink.html).toContain("Fix the &lt;Set&gt; node")
    expect(renderAccessEmail(request, null).text).toContain("Agent Access page")
  })
})

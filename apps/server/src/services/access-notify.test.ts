import { describe, expect, it } from "vitest"
import { accessOutcome, isApprover, renderAccessEmail, renderAccessTelegram } from "./access-notify.ts"

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
  it("show what is asked, escaped for Telegram", () => {
    const text = renderAccessTelegram(request)
    expect(text.startsWith("🔐 <b>Access request</b> · flow")).toBe(true)
    expect(text).toContain("Fix the &lt;Set&gt; node")
    expect(text).toContain("workflow:read, workflow:update")
    expect(text).toContain("Workflows: <code>w1</code>")
    expect(text.endsWith("For 1 h 30 min")).toBe(true)
  })

  it("show at a glance who decided where, and then how the access ended", () => {
    const approved = {
      status: "approved" as const,
      decidedAt: new Date("2026-10-21T10:17:43Z"),
      decidedBy: "telegram:@ShlomiMe",
      decidedVia: "telegram",
      expiresAt: new Date("2026-10-21T10:32:43Z"),
      endedAt: null,
    }
    const zone = "Asia/Jerusalem"
    const text = renderAccessTelegram(request, accessOutcome(approved, zone))
    expect(text.startsWith("✅ <b>Access request</b>")).toBe(true)
    expect(text.endsWith("For 1 h 30 min\n\n✅ <b>Approved</b> by @ShlomiMe via Telegram\nAccess until 13:32")).toBe(
      true,
    )

    const ended = new Date("2026-10-21T10:18:07Z")
    expect(accessOutcome({ ...approved, status: "released", endedAt: ended }, zone).lines).toEqual([
      "✅ <b>Approved</b> by @ShlomiMe via Telegram",
      "⏹ <b>Released</b> by the agent at 13:18",
    ])
    expect(accessOutcome({ ...approved, status: "expired", endedAt: ended }, zone).lines[1]).toBe(
      "⌛ <b>Access ended</b> at 13:18",
    )
    expect(accessOutcome({ ...approved, status: "revoked", endedAt: ended }, zone).lines[1]).toBe(
      "⛔ <b>Revoked</b> at 13:18",
    )
    expect(accessOutcome({ ...approved, status: "denied", decidedBy: "shlomi", decidedVia: "web" }, zone)).toEqual({
      icon: "❌",
      lines: ["❌ <b>Denied</b> by shlomi via n8n-ops"],
    })
    const undecided = { ...approved, decidedAt: null, decidedBy: null, decidedVia: null, expiresAt: null }
    expect(accessOutcome({ ...undecided, status: "expired", endedAt: ended }, zone)).toEqual({
      icon: "⌛",
      lines: ["⌛ <b>Expired</b> without a decision"],
    })
    expect(accessOutcome({ ...undecided, status: "released", endedAt: ended }, zone).lines).toEqual([
      "↩️ <b>Withdrawn</b> by the agent at 13:18",
    ])
    // A name that looks like markup stays text.
    expect(accessOutcome({ ...approved, decidedBy: "<b>x</b>", decidedVia: "web" }, "UTC").lines[0]).toBe(
      "✅ <b>Approved</b> by &lt;b&gt;x&lt;/b&gt; via n8n-ops",
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

import { describe, expect, it } from "vitest"
import { isApprover, renderAccessEmail, renderAccessTelegram } from "./access-notify.ts"

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
    const text = renderAccessTelegram(request, "<i>Approved by @shlomi</i>")
    expect(text).toContain("Access request</b> · flow")
    expect(text).toContain("Fix the &lt;Set&gt; node")
    expect(text).toContain("workflow:read, workflow:update")
    expect(text).toContain("Workflows: <code>w1</code>")
    expect(text).toContain("For 1 h 30 min")
    expect(text.endsWith("<i>Approved by @shlomi</i>")).toBe(true)
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

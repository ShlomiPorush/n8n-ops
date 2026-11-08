import { messageWriting } from "@n8n-ops/shared"
import { describe, expect, it } from "vitest"
import {
  accessOutcome,
  decideButtons,
  editButtons,
  isApprover,
  parsePress,
  presetMinutes,
  type RequestInfo,
  renderAccessEmail,
  renderAccessTelegram,
} from "./access-notify.ts"
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

/** A request for one instance, written as before requests could name several. */
type One = typeof request & { workflowNames?: Record<string, string> }
const one = ({ instance, scopes, workflowIds, workflowNames, ...r }: One): RequestInfo => ({
  ...r,
  instances: [{ position: 0, name: instance, scopes, workflowIds, workflowNames }],
})
const telegramOf = (
  r: One,
  ...rest: Parameters<typeof renderAccessTelegram> extends [unknown, ...infer T] ? T : never
) => renderAccessTelegram(one(r), ...rest)
const emailOf = (r: One, ...rest: Parameters<typeof renderAccessEmail> extends [unknown, ...infer T] ? T : never) =>
  renderAccessEmail(one(r), ...rest)

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
    const text = String(telegramOf(request, zone))
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
    const text = String(telegramOf(named, zone))
    expect(text).toContain("\nWorkflows:\n• Sync &lt;orders&gt;\n• ERP import\n• <code>toString</code>\nFor ")
    expect(String(telegramOf({ ...request, workflowNames: { w1: "Sync" } }, zone))).toContain("\nWorkflow: Sync\n")
    expect(String(telegramOf({ ...request, workflowIds: [] }, zone))).toContain("\nWorkflows: the whole instance\n")
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
    const text = telegramOf(long, zone, accessOutcome(released, zone))
    const sent = TelegramHtml.join([topicGoneNote(2147483647), text])
    expect([...telegramPlainText(sent)].length).toBeLessThan(4096)
    expect(String(text)).toMatch(/<\/code> and \d+ more\nWorkflows:\n(• n+…\n)+• and \d+ more\nFor /)
    expect(String(text)).toContain(`\nWhat was done:\n${"s".repeat(499)}…\n`)

    // Only IDs, as a request made before names were stored.
    const unnamed = String(telegramOf({ ...long, workflowNames: {} }, zone, accessOutcome(released, zone)))
    expect([...telegramPlainText(unnamed)].length).toBeLessThan(4096)
    expect(unnamed).toMatch(/\nWorkflows:\n(• <code>\d+w+<\/code>\n)+• and \d+ more\n/)
  })

  it("show at a glance who decided where, and then how the access ended, how long it was used and what was done", () => {
    const text = String(telegramOf(request, zone, accessOutcome(approved, zone)))
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
    const withLink = emailOf(request, "https://ops.example.com/access/3f2a")
    expect(withLink.subject).toBe("n8n-ops: claude-code asks for 1 h 30 min of access to flow")
    expect(withLink.text).toContain("https://ops.example.com/access/3f2a")
    expect(withLink.html).toContain('href="https://ops.example.com/access/3f2a"')
    expect(withLink.html).toContain("Fix the &lt;Set&gt; node")
    expect(emailOf(request, null).text).toContain("Agent Access page")
  })
})

describe("the access request email", () => {
  const named = {
    ...request,
    workflowIds: ["w1", "w2", "toString"],
    workflowNames: { w1: "Sync <orders>", w2: "ERP import" },
  }

  it("says the requested length in its title and subject, and when the request expires, without the zone", () => {
    const email = emailOf(request, null, zone)
    expect(email.subject).toBe("n8n-ops: claude-code asks for 1 h 30 min of access to flow")
    expect(email.html).toContain("claude-code asks for 1 h 30 min of access to flow")
    // 10:30 UTC is 13:30 in Jerusalem, in summer time.
    expect(email.html).toContain("Without a decision, the request expires at 15/10/2026 13:30.")
    expect(email.text).toContain("\nFor: 1 h 30 min\nRequest expires at 15/10/2026 13:30.\n")
    expect(email.html).not.toContain("Decide by")
    expect(email.html).not.toContain("GMT")
    expect(email.text).not.toContain("GMT")
  })

  it("names one workflow without its ID", () => {
    const email = emailOf({ ...request, workflowNames: { w1: "Sync <orders>" } }, null, zone)
    expect(email.text).toContain("\nWorkflow: Sync <orders>\n")
    expect(email.html).toContain("Sync &lt;orders&gt;")
    expect(email.html).not.toContain("w1")
    expect(email.html).not.toContain("&bull;")
  })

  it("shortens a long name, which Outlook for Windows could not wrap, to 60 characters", () => {
    const long = { ...request, workflowIds: ["w1", "w2"], workflowNames: { w1: "x".repeat(200), w2: "ERP import" } }
    const email = emailOf(long, null, zone)
    expect(email.html).toContain(`>${"x".repeat(59)}…</td>`)
    expect(email.html).not.toContain("x".repeat(60))
  })

  it("lists several workflows one per line, and shows an ID in code font only when the name is not known", () => {
    const email = emailOf(named, null, zone)
    expect(email.text).toContain("\nWorkflows:\n• Sync <orders>\n• ERP import\n• toString\nFor: ")
    expect(email.html).not.toContain("(w1)")
    expect(email.html.match(/&bull;/g)).toHaveLength(3)
    expect(email.html).toMatch(/>Workflows<\/span> <span[^>]*>3<\/span>/)
    expect(email.html).toContain(">Sync &lt;orders&gt;</td>")
    expect(email.html).toContain(">ERP import</td>")
    expect(email.html).toMatch(/<span class="m-mono"[^>]*>toString<\/span><\/td>/)
  })

  it("says when the request is for the whole instance", () => {
    const email = emailOf({ ...request, workflowIds: [] }, null, zone)
    expect(email.text).toContain("\nWorkflows: the whole instance\n")
    expect(email.html).toContain("The whole instance")
    expect(email.html).not.toContain("&bull;")
  })
})

describe("requests for several instances", () => {
  const several: RequestInfo = {
    id: request.id,
    token: "claude-code",
    reason: "Compare the ERP sync on both",
    minutes: 30,
    requestedMinutes: 90,
    decideBy: request.decideBy,
    revision: 3,
    instances: [
      { position: 0, name: "flow", scopes: ["workflow:read"], workflowIds: ["w1"], workflowNames: { w1: "Sync" } },
      { position: 1, name: "n8n13", scopes: ["workflow:read", "execution:read"], workflowIds: [], included: false },
      { position: 2, name: "extra", scopes: ["workflow:read"], workflowIds: [], requested: false },
    ],
  }

  it("give each instance its block, mark the ones left out or added, and say what was asked for", () => {
    const text = String(renderAccessTelegram(several, zone))
    expect(text.startsWith("🔐 <b>Access request</b> · flow +1\n")).toBe(true)
    expect(text).toContain("\n<b>flow</b>\nScopes: <code>workflow:read</code>\nWorkflow: Sync\n")
    expect(text).toContain("\n⬜ <s>n8n13</s> · left out\nScopes: <code>workflow:read, execution:read</code>\n")
    expect(text).toContain("\n<b>extra</b> · added\n")
    expect(text).toContain("\nFor <b>30 min</b> (asked for 1 h 30 min)\nRequest expires at ")
  })

  it("say why an approved instance was left out, and which scopes were no longer allowed", () => {
    const decided: RequestInfo = {
      ...several,
      instances: [
        { position: 0, name: "flow", scopes: ["workflow:read"], workflowIds: [], droppedScopes: ["workflow:delete"] },
        { position: 1, name: "n8n13", scopes: ["workflow:read"], workflowIds: [], droppedReason: "closed" },
      ],
    }
    const text = String(renderAccessTelegram(decided, zone, accessOutcome({ ...approved, changed: true }, zone)))
    expect(text).toContain("Left out, no longer allowed: <code>workflow:delete</code>")
    expect(text).toContain("⬜ <b>n8n13</b> · left out: closed to agents")
    expect(text).toContain("✅ <b>Approved</b> by @ShlomiMe via Telegram, with changes")
  })

  it("stay within Telegram's limit with many instances at their longest, and point to n8n-ops for the rest", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `${i}`.padEnd(83, "w"))
    const many: RequestInfo = {
      ...several,
      token: "t".repeat(5000),
      reason: "r".repeat(500),
      instances: Array.from({ length: 300 }, (_, n) => ({
        position: n,
        name: `${n}`.padEnd(5000, "i"),
        scopes: Array.from({ length: 30 }, (_, i) => `scope:${i}`.padEnd(80, "s")),
        workflowIds: ids,
        workflowNames: Object.fromEntries(ids.map((id) => [id, "n".repeat(5000)])),
        droppedScopes: ["x".repeat(300)],
      })),
    }
    const released = {
      ...approved,
      status: "released" as const,
      decidedBy: "d".repeat(5000),
      endedAt: new Date("2026-10-21T10:40:00Z"),
      summary: "s".repeat(1000),
      callCount: 123456,
      refusedCount: 12345,
    }
    for (const outcome of [undefined, accessOutcome(released, zone)]) {
      const text = renderAccessTelegram(many, zone, outcome)
      const sent = TelegramHtml.join([topicGoneNote(2147483647), text])
      expect([...telegramPlainText(sent)].length).toBeLessThan(4096)
      expect(String(text)).toMatch(/\nand \d+ more instances\nFull details in n8n-ops\.\n/)
    }
    // A few instances that fit only on one line each.
    const six = { ...many, instances: many.instances.slice(0, 6) }
    const text = String(renderAccessTelegram(six, zone))
    expect([...telegramPlainText(text)].length).toBeLessThan(4096)
    expect(text).toMatch(/: 30 scopes, 50 workflows\n/)
    expect(text).toContain("\nFull details in n8n-ops.\n")
  })

  it("email every instance with its own scopes and workflows", () => {
    const email = renderAccessEmail({ ...several, instances: several.instances.slice(0, 2) }, null, zone)
    // n8n13 is left out of the draft, so the email names only flow.
    expect(email.subject).toBe("n8n-ops: claude-code asks for 30 min of access to flow")
    const [flow, n8n13] = several.instances as [RequestInfo["instances"][0], RequestInfo["instances"][0]]
    const both = renderAccessEmail(
      { ...several, instances: [flow, { ...n8n13, included: true }] },
      "https://ops.example.com/access/1",
      zone,
    )
    expect(both.subject).toBe("n8n-ops: claude-code asks for 30 min of access to 2 instances")
    expect(both.text).toContain("\nflow\nScopes: workflow:read\nWorkflows:\n• Sync\n")
    expect(both.text).toContain("\nn8n13\nScopes: workflow:read, execution:read\nWorkflows: the whole instance\n")
    expect(both.text).toContain("Approve, change or deny: https://ops.example.com/access/1")
    expect(both.html).toContain("n8n13")
    expect(both.html).toContain("Approve, change or deny")
  })
})

describe("request message buttons", () => {
  const several: RequestInfo = {
    id: request.id,
    token: "claude-code",
    reason: "Compare",
    minutes: 30,
    requestedMinutes: 90,
    decideBy: request.decideBy,
    revision: 7,
    instances: [
      { position: 0, name: "flow", scopes: ["workflow:read"], workflowIds: [] },
      { position: 4, name: "n8n13", scopes: ["workflow:read"], workflowIds: [], included: false },
      { position: 5, name: "added", scopes: ["workflow:read"], workflowIds: [], requested: false },
      { position: 6, name: "gone", scopes: ["workflow:read"], workflowIds: [], deleted: true },
    ],
  }
  const data = (rows: { callback_data?: string; url?: string; text: string }[][]) =>
    rows.flat().map((b) => b.callback_data ?? b.url)

  it("approve the revision shown, and open the edit keyboard", () => {
    expect(data(decideButtons(several, "https://ops.example.com/access/1"))).toEqual([
      `xa:${request.id}:7`,
      `xd:${request.id}`,
      `xe:${request.id}`,
      "https://ops.example.com/access/1",
    ])
    // Telegram takes only https links.
    expect(data(decideButtons(several, "http://ops.local/access/1"))).toHaveLength(3)
  })

  it("switch only the instances the agent asked for to the state shown, with the minutes and Done", () => {
    const rows = editButtons(several, 240, null)
    const all = rows.flat()
    expect(all.slice(0, 2)).toEqual([
      { text: "✅ flow", callback_data: `xt:${request.id}:0:0:7` },
      { text: "⬜ n8n13", callback_data: `xt:${request.id}:4:1:7` },
    ])
    expect(all.map((b) => b.text)).not.toContain("✅ added")
    expect(all.map((b) => b.text)).not.toContain("✅ gone")
    expect(all.filter((b) => b.callback_data?.startsWith("xm:")).map((b) => b.text)).toEqual([
      "15 min",
      "• 30 min",
      "1 h",
      "1 h 30 min",
      "2 h",
      "4 h",
    ])
    expect(all.at(-1)).toEqual({ text: "✓ Done", callback_data: `xv:${request.id}` })
    // Within Telegram's 64 bytes, and at most 4 minutes a row.
    for (const b of all) expect(Buffer.byteLength(b.callback_data ?? "")).toBeLessThanOrEqual(64)
    expect(Math.max(...rows.map((r) => r.length))).toBeLessThanOrEqual(4)
  })

  it("always offer a valid duration, also when the longest allowed is under every preset", () => {
    expect(presetMinutes({ minutes: 30, requestedMinutes: 30 }, 5)).toEqual([5])
    expect(presetMinutes({ minutes: 3, requestedMinutes: 45 }, 60)).toEqual([3, 15, 30, 45, 60])
  })

  it("read every press, and nothing that is not one", () => {
    const id = request.id
    expect(parsePress(`xa:${id}:7`)).toEqual({ action: "approve", id, revision: 7 })
    // A message sent before edits existed approves only a request nobody edited.
    expect(parsePress(`xa:${id}`)).toEqual({ action: "approve", id, revision: 0 })
    expect(parsePress(`xd:${id}`)).toEqual({ action: "deny", id })
    expect(parsePress(`xe:${id}`)).toEqual({ action: "edit", id })
    expect(parsePress(`xv:${id}`)).toEqual({ action: "done", id })
    expect(parsePress(`xt:${id}:4:1:7`)).toEqual({
      action: "change",
      id,
      revision: 7,
      change: { position: 4, included: true },
    })
    expect(parsePress(`xm:${id}:45:7`)).toEqual({ action: "change", id, revision: 7, change: { minutes: 45 } })
    for (const bad of [
      undefined,
      "",
      "r:abc",
      `xa:${id}:x`,
      `xa:${id}:1:2`,
      "xa:not-an-id",
      `xd:${id}:1`,
      `xt:${id}:4:2:7`,
      `xt:${id}:4:1`,
      `xt:${id}:-1:1:7`,
      `xm:${id}:1.5:7`,
      `xm:${id}:45`,
      `xq:${id}`,
    ])
      expect(parsePress(bad), bad).toBeNull()
  })
})

import { messageWriting } from "@n8n-ops/shared"
import { describe, expect, it } from "vitest"
import {
  accessOutcome,
  decideButtons,
  editButtons,
  type InstanceInfo,
  isApprover,
  parsePress,
  presetMinutes,
  type RequestInfo,
  renderAccessEmail,
  renderAccessTelegram,
  telegramRequest,
} from "./access-notify.ts"
import { topicGoneNote } from "./alert-routing.ts"
import { TelegramHtml, telegramPlainText } from "./telegram.ts"

/** What a waiting request's message says when Approve is not offered. */
const TOO_LONG = "Too long to approve in Telegram. Open the request in n8n-ops to approve it."

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
    expect(String(text)).toContain(`\nWhat was done:\n\u{200E}<i>${"s".repeat(499)}…</i>\n`)

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
      "\u{200E}<i>Fixed the &lt;Set&gt; node.</i>",
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
    expect(email.text).toContain("\nWorkflows:\n• Sync <orders>\n• ERP import\n• by its ID:\n> toString\nFor: ")
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
      // While it waits, the message says where to approve it; once decided, where the details are.
      const more = outcome ? "Full details in n8n-ops." : TOO_LONG
      expect(String(text)).toMatch(/\nand \d+ more instances\n/)
      expect(String(text)).toContain(`more instances\n${more}\n`)
    }
    // A few instances that fit only on one line each.
    const six = { ...many, instances: many.instances.slice(0, 6) }
    const text = String(renderAccessTelegram(six, zone))
    expect([...telegramPlainText(text)].length).toBeLessThan(4096)
    expect(text).toMatch(/: 30 scopes, 50 workflows\n/)
    expect(text).toContain(`\n${TOO_LONG}\n`)
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

describe("what an agent wrote, in request messages", () => {
  const padding = "⠀".repeat(38)
  /** Line breaks of every kind, direction marks, look-alike blanks, markup and an emoji joined with ZWJ. */
  const hostile = {
    token: "Scopes: workflow:read\nFor 5 min",
    reason: `Read wf1 only.\n\nScopes: workflow:read\r\nWorkflow: wf1 For 5 min\u0085‮${padding}Scopes: <b>x</b> 👩‍💻`,
    summary: "Done.\n\n✅ Approved by someone\nFor 5 min",
  }
  const benign = { token: "claude-code", reason: "Read wf1 and fix it", summary: "Fixed the sync." }
  const ask = (words: typeof benign): RequestInfo => ({
    ...one({ ...request, workflowIds: ["w1"], workflowNames: { w1: "Sync" } }),
    token: words.token,
    reason: words.reason,
  })
  const released = (words: typeof benign) =>
    accessOutcome(
      {
        ...approved,
        status: "released",
        endedAt: new Date("2026-10-21T10:40:00Z"),
        summary: words.summary,
        callCount: 3,
      },
      zone,
    )
  const lines = (text: TelegramHtml) => String(text).split("\n")
  const changed = (a: string[], b: string[]) => a.flatMap((line, n) => (line === b[n] ? [] : [n]))
  const starting = (all: string[], label: string) => all.filter((l) => telegramPlainText(l).startsWith(label))

  it("keep the agent's name and reason on a line of their own each in Telegram, set apart from the request", () => {
    const shown = telegramRequest(ask(hostile), zone)
    const plain = telegramRequest(ask(benign), zone)
    expect(shown.complete).toBe(true)
    expect(plain.complete).toBe(true)
    const [a, b] = [lines(shown.text), lines(plain.text)]
    expect(a).toHaveLength(b.length)
    // Only the agent's own lines differ.
    expect(changed(a, b)).toEqual([1, 2])
    expect(a[1]).toMatch(/^Agent <b>[^<]*<\/b>:$/)
    expect(a[2]).toMatch(/^💬 \u{200E}<i>[^<]*<\/i>$/u)
    expect(a[2]).toContain("&lt;b&gt;x&lt;/b&gt; 👩‍💻")
    for (const label of ["Scopes:", "Workflow", "For "]) expect(starting(a, label)).toHaveLength(1)
  })

  it("show a reason and a summary written right to left from the right in Telegram, also when they open in English", () => {
    // Hebrew is written as escapes: tracked files hold no Hebrew characters (AGENTS.md).
    const hebrew = {
      token: "Agents on SHLOMI",
      // A Hebrew sentence that opens with English terms and has more of them inside.
      reason:
        "Phase 0 \u{5E9}\u{5DC} \u{5D4}-CRM: workflow \u{5D6}\u{5DE}\u{5E0}\u{5D9} \u{5D0}\u{5D7}\u{5D3} \u{5E9}\u{5DE}\u{5D7}\u{5D6}\u{5D9}\u{5E8} \u{5E1}\u{5E4}\u{5D9}\u{5E8}\u{5D5}\u{5EA}, \u{5D1}\u{5DC}\u{5D9} \u{5E9}\u{5D9}\u{5E0}\u{5D5}\u{5D9} \u{5D1}-workflows \u{5E7}\u{5D9}\u{5D9}\u{5DE}\u{5D9}\u{5DD}",
      summary:
        "Read workflow \u{5D0}\u{5D7}\u{5D3} \u{5D1}\u{5DC}\u{5D1}\u{5D3}, \u{5E7}\u{5E8}\u{5D9}\u{5D0}\u{5D4} \u{5D1}\u{5DC}\u{5D1}\u{5D3}, \u{5D5}\u{5DC}\u{5D0} \u{5E9}\u{5D9}\u{5E0}\u{5D9}\u{5EA}\u{5D9} \u{5D3}\u{5D1}\u{5E8}",
    }
    const a = lines(renderAccessTelegram(ask(hebrew), zone, released(hebrew)))
    expect(a[1]).toBe("Agent <b>Agents on SHLOMI</b>:")
    expect(a[2]).toBe(`💬 \u{200F}<i>${hebrew.reason}</i>`)
    expect(a[a.indexOf("What was done:") + 1]).toBe(`\u{200F}<i>${hebrew.summary}</i>`)
    // English reads left to right, also when it opens with a Hebrew word.
    const b = lines(renderAccessTelegram(ask(benign), zone, released(benign)))
    expect(b[2]).toBe("💬 \u{200E}<i>Read wf1 and fix it</i>")
    expect(b[b.indexOf("What was done:") + 1]).toBe("\u{200E}<i>Fixed the sync.</i>")
    const sync = "\u{5E1}\u{5E0}\u{5DB}\u{5E8}\u{5D5}\u{5DF}: Read the workflow and list its nodes."
    const mixed = lines(renderAccessTelegram(ask({ ...benign, reason: sync }), zone))
    expect(mixed[2]).toBe(`💬 \u{200E}<i>${sync}</i>`)
  })

  it("show a reason written right to left from the right in the email", () => {
    const reason =
      "\u{5E7}\u{5E8}\u{5D9}\u{5D0}\u{5D4} \u{5D1}\u{5DC}\u{5D1}\u{5D3} \u{5E9}\u{5DC} workflow \u{5D0}\u{5D7}\u{5D3}"
    const rtl = renderAccessEmail(ask({ ...benign, reason }), null, zone).html
    expect(rtl).toContain('<td dir="rtl" align="right" class="m-ink m-cell"')
    expect(rtl).toContain("text-align:right;")
    expect(renderAccessEmail(ask(benign), null, zone).html).not.toContain('dir="rtl"')
  })

  it("keep what the agent said it did on one line of its own in Telegram", () => {
    const a = lines(renderAccessTelegram(ask(hostile), zone, released(hostile)))
    const b = lines(renderAccessTelegram(ask(benign), zone, released(benign)))
    expect(a).toHaveLength(b.length)
    const done = b.indexOf("What was done:")
    expect(changed(a, b)).toEqual([1, 2, done + 1])
    expect(a[done + 1]).toMatch(/^\u{200E}<i>[^<]*<\/i>$/u)
    expect(starting(a, "For ")).toHaveLength(1)
  })

  it("quote the agent's name and reason in the email text, in lines of at most 60 characters", () => {
    const a = renderAccessEmail(ask(hostile), null, zone).text.split("\n")
    const b = renderAccessEmail(ask(benign), null, zone).text.split("\n")
    const own = (all: string[]) => all.filter((l) => !l.startsWith("> "))
    expect(own(a)).toEqual(own(b))
    expect(a[0]).toBe("An agent asks for 1 h 30 min of access to flow.")
    expect(a.slice(a.indexOf("Agent:") + 1, a.indexOf("Agent:") + 2)).toEqual(["> Scopes: workflow:read For 5 min"])
    for (const line of a.filter((l) => l.startsWith("> "))) expect([...line].length).toBeLessThanOrEqual(62)
    for (const label of ["Scopes:", "Workflow", "For:"]) expect(a.filter((l) => l.startsWith(label))).toHaveLength(1)
    const email = renderAccessEmail(ask(hostile), null, zone)
    expect(email.subject).toBe("n8n-ops: Scopes: workflow:read For 5 min asks for 1 h 30 min of access to flow")
  })

  it("quote a workflow the email can name only by its ID", () => {
    const text = (workflowIds: string[]) =>
      renderAccessEmail(one({ ...request, workflowIds }), null, zone).text.split("\n")
    const single = text([`${padding}Scopes: workflow:read`])
    expect(single.filter((l) => l.startsWith("Scopes:"))).toEqual(["Scopes: workflow:read, workflow:update"])
    expect(single).toContain("Workflow, by its ID:")
    expect(single).toContain(`> ${padding}Scopes: workflow:read`)
    const several = text(["w1", `${padding}For: 5 min`])
    expect(several.join("\n")).toContain(`\nWorkflows:\n• by its ID:\n> w1\n• by its ID:\n> ${padding}For: 5 min\n`)
    expect(several.filter((l) => l.startsWith("For:"))).toHaveLength(1)
  })

  it("show workflow names and IDs on one line, and approve in n8n-ops only when that changed one", () => {
    const unshown =
      "A workflow name or ID here has a line break or control character. Open the request in n8n-ops to approve it."
    for (const r of [
      one({ ...request, workflowIds: ["w1\nFor 5 min"] }),
      one({ ...request, workflowIds: ["a", "b"], workflowNames: { a: "Sync\norders", b: "Sync orders" } }),
    ]) {
      const { text, complete } = telegramRequest(r, zone)
      expect(complete).toBe(false)
      expect(starting(lines(text), "For ")).toHaveLength(1)
      expect(telegramPlainText(text)).toContain(unshown)
      expect(data(decideButtons(r, null, complete))).not.toContain(`xa:${r.id}:0:g`)
    }
    // A name that only has to keep its spaces is shown as it is.
    const spaced = one({ ...request, workflowNames: { w1: "Sync  orders " } })
    expect(telegramRequest(spaced, zone).complete).toBe(true)
    expect(String(telegramRequest(spaced, zone).text)).toContain("\nWorkflow: Sync  orders \n")
  })
})

const data = (rows: { callback_data?: string; url?: string; text: string }[][]) =>
  rows.flat().map((b) => b.callback_data ?? b.url)

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

  it("approve the revision shown, and open the edit keyboard", () => {
    expect(data(decideButtons(several, "https://ops.example.com/access/1", true))).toEqual([
      `xa:${request.id}:7:g`,
      `xd:${request.id}`,
      `xe:${request.id}`,
      "https://ops.example.com/access/1",
    ])
    // Telegram takes only https links.
    expect(data(decideButtons(several, "http://ops.local/access/1", true))).toHaveLength(3)
    // Only a message that names everything Approve grants offers it.
    expect(data(decideButtons(several, null, false))).toEqual([`xd:${request.id}`, `xe:${request.id}`])
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
    expect(parsePress(`xa:${id}:7:g`)).toEqual({ action: "approve", id, revision: 7, full: true })
    // Messages drawn before the agent's words were set apart, and before Approve required a complete message; the
    // one from before edits existed is revision 0.
    expect(parsePress(`xa:${id}:7:f`)).toEqual({ action: "approve", id, revision: 7, full: false })
    expect(parsePress(`xa:${id}:7`)).toEqual({ action: "approve", id, revision: 7, full: false })
    expect(parsePress(`xa:${id}`)).toEqual({ action: "approve", id, revision: 0, full: false })
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
      `xa:${id}:1:f:f`,
      `xa:${id}::f`,
      `xa:${id}:f`,
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

describe("one-tap Approve in Telegram", () => {
  const scopes = (n: number) => Array.from({ length: n }, (_, i) => `resource${i}:update`)
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `wf-${i}`)
  const base: RequestInfo = {
    id: request.id,
    token: "claude-code",
    reason: "Fix the sync",
    minutes: 30,
    decideBy: request.decideBy,
    revision: 2,
    instances: [],
  }
  const single = (i: Partial<InstanceInfo>): RequestInfo => ({
    ...base,
    instances: [{ position: 0, name: "flow", scopes: scopes(2), workflowIds: [], ...i }],
  })
  const longName = "n".repeat(120)
  /** Each case, and whether its message can name everything. */
  const cases: [string, RequestInfo, boolean][] = [
    ["one instance, two scopes", single({}), true],
    ["one instance, 40 scopes", single({ scopes: scopes(40) }), true],
    ["one instance, 300 scopes", single({ scopes: scopes(300) }), false],
    ["one instance, 50 workflows", single({ workflowIds: ids(50) }), true],
    [
      "names that differ only after 100 characters",
      single({ workflowIds: ["a", "b"], workflowNames: { a: `${longName}1`, b: `${longName}2` } }),
      true,
    ],
    ["a long workflow ID without a name", single({ workflowIds: ["i".repeat(150)] }), true],
    ["50 long workflow IDs without names", single({ workflowIds: ids(50).map((w) => w.padEnd(120, "i")) }), false],
    ["a long instance name", single({ name: "f".repeat(250) }), false],
    [
      "two instances, 30 scopes each",
      {
        ...base,
        instances: [0, 1].map((n) => ({ position: n, name: `flow${n}`, scopes: scopes(30), workflowIds: [] })),
      },
      true,
    ],
    [
      "two instances, one left out",
      {
        ...base,
        instances: [
          { position: 0, name: "flow", scopes: scopes(30), workflowIds: ids(3) },
          { position: 1, name: "n8n13", scopes: scopes(300), workflowIds: [], included: false },
        ],
      },
      true,
    ],
    [
      "40 instances",
      {
        ...base,
        instances: Array.from({ length: 40 }, (_, n) => ({
          position: n,
          name: `instance-${n}`.padEnd(60, "x"),
          scopes: scopes(5),
          workflowIds: ids(3),
        })),
      },
      false,
    ],
  ]

  /** The lines that name, in full and in order, what Approve grants on an instance. */
  const grantLines = (i: InstanceInfo) => {
    const name = (w: string) => i.workflowNames?.[w] ?? w
    const workflows =
      i.workflowIds.length === 0
        ? ["Workflows: the whole instance"]
        : i.workflowIds.length === 1
          ? [`Workflow: ${name(i.workflowIds[0] ?? "")}`]
          : ["Workflows:", ...i.workflowIds.map((w) => `• ${name(w)}`)]
    return [`Scopes: ${i.scopes.join(", ")}`, ...workflows]
  }

  /** Whether the message names each instance Approve grants, and under it, everything granted there. */
  const namesEverything = (r: RequestInfo, text: TelegramHtml) => {
    const lines = String(text).split("\n").map(telegramPlainText)
    return r.instances
      .filter((i) => i.included !== false)
      .every((i) => {
        let section = lines
        if (r.instances.length === 1) {
          if (lines[0] !== `🔐 Access request · ${i.name}`) return false
        } else {
          const at = lines.indexOf(i.name)
          if (at < 0) return false
          const end = lines.indexOf("", at)
          section = lines.slice(at, end < 0 ? undefined : end)
        }
        const want = grantLines(i)
        const start = section.indexOf(want[0] ?? "")
        return start >= 0 && want.every((line, n) => section[start + n] === line)
      })
  }

  it.each(cases)("is offered only when the message names everything it grants: %s", (_, r, fits) => {
    const { text, complete } = telegramRequest(r, zone)
    const plain = telegramPlainText(text)
    const approve = decideButtons(r, null, complete)
      .flat()
      .filter((b) => b.callback_data?.startsWith("xa:"))
    expect(approve.map((b) => b.callback_data)).toEqual(fits ? [`xa:${r.id}:2:g`] : [])
    expect(namesEverything(r, text)).toBe(fits)
    // Either way the message fits in Telegram, also with the note that the topic was gone.
    expect([...telegramPlainText(TelegramHtml.join([topicGoneNote(2147483647), text]))].length).toBeLessThan(4096)
    // A waiting request that cannot be approved here says where it can be.
    expect(plain.includes(TOO_LONG)).toBe(!fits)
  })

  it("says nothing about approving once the request is decided", () => {
    const [, long] = cases.find(([name]) => name === "40 instances") ?? []
    const decided = telegramRequest(long as RequestInfo, zone, accessOutcome(approved, zone))
    expect(telegramPlainText(decided.text)).not.toContain(TOO_LONG)
    expect(telegramPlainText(decided.text)).toContain("Full details in n8n-ops.")
  })
})

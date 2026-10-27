import { messageWriting } from "@n8n-ops/shared"
import nodemailer from "nodemailer"
import { describe, expect, it } from "vitest"
import { renderAccessEmail } from "./access-notify.ts"
import {
  banner,
  button,
  formatDate,
  kv,
  link,
  mono,
  panel,
  panelText,
  paragraph,
  render,
  Safe,
  stats,
  table,
  tag,
} from "./email-layout.ts"
import { mailOptions, renderReport } from "./reports.ts"

const hostile = '<script>alert("x")</script>'

describe("email layout", () => {
  it("escapes every value it is given", () => {
    const html = render({
      title: hostile,
      topic: hostile,
      intro: hostile,
      footer: hostile,
      blocks: [
        panel(hostile, [kv([[hostile, hostile]]), table([hostile], [[hostile]]), panelText(hostile)], {
          count: hostile,
          note: hostile,
        }),
        banner("fail", hostile, hostile),
        stats([{ label: hostile, value: hostile, note: hostile }]),
        paragraph(hostile),
        tag(hostile),
        mono(hostile),
      ],
    })
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
  })

  it("inserts the output of a block as markup", () => {
    expect(panel("Hosts", [new Safe("<b>kept</b>")]).html).toContain("<b>kept</b>")
  })

  it("links only http and https addresses", () => {
    expect(link("Open", "javascript:alert(1)").html).not.toContain("<a ")
    expect(link("Open", "https://ops.example.com/access/1").html).toContain('href="https://ops.example.com/access/1"')
    expect(button("Approve or deny", "data:text/html,x").html).toBe("")
  })

  it("keeps line breaks", () => {
    expect(paragraph("one\ntwo").html).toContain("one<br>two")
  })

  it("draws addresses as links in the colour of the text around them, without the full stop", () => {
    const html = paragraph("Write to ops@example.com.").html
    expect(html).toContain('<a href="mailto:ops@example.com" class="m-ink" style="color:#111814;')
    expect(html).toContain("ops@example.com</a>.")
    expect(paragraph("Not an address: a@b or @example.com").html).not.toContain("<a ")
  })

  it("scans hostile text for addresses in linear time", () => {
    const text = `${"a.".repeat(40_000)}@${"b-".repeat(40_000)}`
    const start = performance.now()
    paragraph(text)
    expect(performance.now() - start).toBeLessThan(500)
  })

  it("shortens long technical values in the middle", () => {
    const short = mono("x".repeat(30) + "y".repeat(30), 21).html
    expect(short).toContain("xxxxxxxxxxxxx…yyyyyyy")
  })

  it("has a dark theme, a phone layout and a 600px frame for Outlook", () => {
    const html = render({ title: "t", topic: "Test" })
    expect(html).toContain("prefers-color-scheme: dark")
    expect(html).toContain("max-width: 620px")
    expect(html).toContain('<!--[if mso]><table role="presentation" width="600"')
  })

  it("gives Outlook a rounded shape only for the fixed-size topic tag", () => {
    const html = render({ title: "t", topic: "Test", blocks: [panel("p", [kv([["a", tag("b", "ok")]])])] })
    expect(html.match(/v:roundrect/g)).toHaveLength(2) // the opening and closing tag of one shape
  })

  it("writes dates in the console's time zone with the zone's short name, day/month/year for Browser (EM-6)", () => {
    const when = new Date("2026-10-16T22:30:00Z")
    const zone = (timezone: string) => messageWriting({ timezone })
    expect(formatDate(when, zone("Asia/Jerusalem"), true)).toBe("17/10/2026 01:30 GMT+3")
    expect(formatDate(when, zone("UTC"))).toBe("16/10/2026")
    expect(formatDate(when, zone("Not/AZone"), true)).toBe("16/10/2026 22:30 UTC")
    expect(render({ title: "t", topic: "Test", when, dates: zone("Asia/Jerusalem") })).toContain(
      "17/10/2026 01:30 GMT+3",
    )
  })

  it("follows the Date and Time format chosen in Settings (EM-6, FW-9)", () => {
    const when = new Date("2026-10-16T22:30:00Z")
    const dates = messageWriting({ timezone: "Europe/Berlin", dateFormat: "MM/DD/YYYY", timeFormat: "12h" })
    expect(formatDate(when, dates, true)).toBe("10/17/2026 12:30 AM CEST")
    expect(formatDate(when, messageWriting({ timezone: "UTC", dateFormat: "DD.MM.YYYY" }))).toBe("16.10.2026")
    expect(render({ title: "t", topic: "Test", when, dates })).toContain("10/17/2026 12:30 AM CEST")
  })
})

describe("emails", () => {
  const report = () =>
    renderReport({
      period: "weekly",
      openByInstance: [
        { name: "n8n-7", open: 3 },
        { name: "flow", open: 0 },
      ],
      topWorkflows: [{ workflow: "Sync orders", instance: "n8n-7", failures: 1_204 }],
      incidents: [{ at: new Date("2026-10-15T08:00:00Z"), text: "n8n-7 is down: <b>HTTP 502</b>" }],
      backups: [
        { name: "n8n-7", status: "failed", at: new Date("2026-10-15T02:00:00Z") },
        { name: "flow", status: "ok", at: new Date("2026-10-15T02:00:00Z") },
      ],
      versions: [{ name: "n8n-7", version: "2.41.2" }],
      latest: "2.44.0",
      dates: messageWriting({ timezone: "Asia/Jerusalem" }),
      when: new Date("2026-10-16T05:00:00Z"),
    })

  it("leads the report with what needs a look", () => {
    const r = report()
    expect(r.subject).toBe("n8n-ops weekly report: 3 open problems")
    expect(r.html).toContain("3 open problems on 1 instance")
    expect(r.html).toContain("Weekly report")
    expect(r.html).toContain("1,204")
    expect(r.html).toContain("15/10/2026 11:00 GMT+3")
    expect(r.text).toContain("15/10/2026 11:00 GMT+3")
  })

  it("gives the exact window it counts, with the zone (EM-6)", () => {
    const r = report()
    expect(r.html).toContain("From 09/10/2026 08:00 to 16/10/2026 08:00 GMT+3, on every n8n instance.")
    expect(r.text).toContain("From 09/10/2026 08:00 to 16/10/2026 08:00 GMT+3")
  })

  it("names the zone at both ends of a window that daylight saving changed", () => {
    const r = renderReport({
      period: "daily",
      openByInstance: [],
      topWorkflows: [],
      incidents: [],
      backups: [],
      versions: [],
      latest: null,
      dates: messageWriting({ timezone: "Europe/Berlin", dateFormat: "DD.MM.YYYY" }),
      when: new Date("2026-10-25T07:00:00Z"),
    })
    expect(r.text).toContain("From 24.10.2026 09:00 CEST to 25.10.2026 08:00 CET")
  })

  it("says plainly when there is nothing to report", () => {
    const r = renderReport({
      period: "daily",
      openByInstance: [],
      topWorkflows: [],
      incidents: [],
      backups: [],
      versions: [],
      latest: null,
    })
    expect(r.html).toContain("No open problems")
    expect(r.html).toContain("Nothing needs a look.")
    expect(r.html).toContain("No health alerts.")
  })

  it("says why it was sent: on the schedule, or as a test", () => {
    const base = { openByInstance: [], topWorkflows: [], incidents: [], backups: [], versions: [], latest: null }
    expect(renderReport({ ...base, period: "daily" }).html).toContain(
      "You get this because the daily report is on in Settings → Email Reports.",
    )
    const test = renderReport({ ...base, period: "daily", test: true }).html
    expect(test).toContain("This is a test sent from Settings → Email Reports.")
    expect(test).not.toContain("You get this because")
  })

  it("speaks only for instances whose version is known", () => {
    const r = renderReport({
      period: "daily",
      openByInstance: [],
      topWorkflows: [],
      incidents: [],
      backups: [],
      versions: [
        { name: "n8n-7", version: "2.44.0" },
        { name: "flow", version: null },
      ],
      latest: "2.44.0",
    })
    expect(r.html).toContain("Every instance with a known version runs n8n 2.44.0 or later.")
  })

  it("has no emoji in subjects", () => {
    const access = renderAccessEmail(
      {
        id: "1",
        instance: "flow",
        token: "claude-code",
        reason: "Fix a node",
        scopes: ["workflow:read"],
        workflowIds: [],
        minutes: 30,
        decideBy: new Date("2026-10-16T10:00:00Z"),
      },
      "https://ops.example.com/access/1",
      messageWriting({ timezone: "Asia/Jerusalem" }),
    )
    for (const subject of [report().subject, access.subject]) expect(subject).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(access.html).toContain("16/10/2026 13:00 GMT+3")
  })

  it("keeps every line of the sent message under the SMTP limit of 998 characters", async () => {
    const r = report()
    // One very long line in the HTML, as a table row can be.
    const html = r.html.replace("</body>", `<p>${"x".repeat(9_000)}</p></body>`)
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true })
    const sent = await transport.sendMail(mailOptions({ ...r, html }, "ops@example.com", ["a@example.com"]))
    const raw = (sent.message as Buffer).toString("utf8")
    const longest = Math.max(...raw.split(/\r?\n/).map((l) => l.length))
    expect(longest).toBeLessThanOrEqual(998)
    expect(raw).toContain("Content-Transfer-Encoding: base64")
  })
})

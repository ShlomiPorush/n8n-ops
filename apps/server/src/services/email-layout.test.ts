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

  it("writes dates as day/month/year in the console's time zone", () => {
    const when = new Date("2026-10-16T22:30:00Z")
    expect(formatDate(when, "Asia/Jerusalem", true)).toBe("17/10/2026 01:30")
    expect(formatDate(when, "UTC")).toBe("16/10/2026")
    expect(formatDate(when, "Not/AZone", true)).toBe("16/10/2026 22:30")
    expect(render({ title: "t", topic: "Test", when, timeZone: "Asia/Jerusalem" })).toContain("17/10/2026 01:30")
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
      timeZone: "Asia/Jerusalem",
      when: new Date("2026-10-16T05:00:00Z"),
    })

  it("leads the report with what needs a look", () => {
    const r = report()
    expect(r.subject).toBe("n8n-ops weekly report: 3 open problems")
    expect(r.html).toContain("3 open problems on 1 instance")
    expect(r.html).toContain("Weekly report")
    expect(r.html).toContain("1,204")
    expect(r.html).toContain("15/10/2026 11:00")
    expect(r.text).toContain("15/10/2026 11:00")
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
      "Asia/Jerusalem",
    )
    for (const subject of [report().subject, access.subject]) expect(subject).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(access.html).toContain("16/10/2026 13:00 (Asia/Jerusalem)")
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

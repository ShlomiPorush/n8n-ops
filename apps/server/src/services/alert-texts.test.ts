import { describe, expect, it } from "vitest"
import { backupAlerts } from "./backups.ts"
import { healthAlerts, type ProbeResult } from "./health.ts"
import { telegramPlainText } from "./telegram.ts"

const failed = (error?: string): ProbeResult => ({ ok: false, status: 503, ms: 12, error })
const link = '<a href="https://example.com">open</a> & more'
const escapedLink = '&lt;a href="https://example.com"&gt;open&lt;/a&gt; &amp; more'

describe("health alert texts", () => {
  it("keep their wording for ordinary values", () => {
    expect(healthAlerts.down("prod", failed())).toBe("<b>prod is not responding</b>\nHTTP 503")
    expect(healthAlerts.down("prod", failed("connect ECONNREFUSED"))).toBe(
      "<b>prod is not responding</b>\nconnect ECONNREFUSED",
    )
    expect(healthAlerts.up("prod")).toBe("<b>prod is responding again</b>")
    expect(healthAlerts.workerDown("prod", { ...failed(), url: "http://w1:5678/healthz" })).toBe(
      "<b>Worker down on prod</b>\nhttp://w1:5678/healthz: HTTP 503",
    )
    expect(healthAlerts.workerUp("prod", "http://w1:5678/healthz")).toBe(
      "<b>Worker back on prod</b>\nhttp://w1:5678/healthz",
    )
    expect(healthAlerts.backlog("prod", 42, 10)).toBe(
      "<b>Queue backlog on prod</b>\n42 jobs waiting for more than 10 minutes",
    )
    expect(healthAlerts.backlogCleared("prod")).toBe("<b>Queue backlog cleared on prod</b>")
  })

  it("escape names, URLs and errors, so no markup gets in", () => {
    expect(healthAlerts.down("R&D <prod>", failed(link))).toBe(
      `<b>R&amp;D &lt;prod&gt; is not responding</b>\n${escapedLink}`,
    )
    expect(healthAlerts.workerDown("prod", { ...failed(link), url: "http://w1/?a=1&b=<2>" })).toBe(
      `<b>Worker down on prod</b>\nhttp://w1/?a=1&amp;b=&lt;2&gt;: ${escapedLink}`,
    )
    expect(healthAlerts.workerUp("<i>x</i>", "http://w1/<b>")).toBe(
      "<b>Worker back on &lt;i&gt;x&lt;/i&gt;</b>\nhttp://w1/&lt;b&gt;",
    )
    expect(healthAlerts.up("a&b")).toBe("<b>a&amp;b is responding again</b>")
    expect(healthAlerts.backlog("a&b", 1, 1)).toContain("on a&amp;b</b>")
    expect(healthAlerts.backlogCleared("a&b")).toBe("<b>Queue backlog cleared on a&amp;b</b>")
  })

  it("shorten long URLs and errors", () => {
    const text = healthAlerts.workerDown("prod", { ...failed("e".repeat(5000)), url: `http://w/${"u".repeat(5000)}` })
    const [, line] = text.split("\n")
    const [url, error] = (line ?? "").split(": ")
    expect(url).toHaveLength(200)
    expect(url?.endsWith("…")).toBe(true)
    expect(error).toHaveLength(500)
    expect(error?.endsWith("…")).toBe(true)
  })
})

describe("backup alert texts", () => {
  it("keep their wording for ordinary values", () => {
    expect(backupAlerts.failed("prod", "upload failed")).toBe("<b>Backup failed on prod</b>\nupload failed")
    expect(backupAlerts.failed("prod")).toBe("<b>Backup failed on prod</b>\n")
    expect(backupAlerts.working("prod")).toBe("<b>Backups of prod are working again</b>")
    expect(backupAlerts.stale("prod", 26)).toBe(
      "<b>Backup is stale on prod</b>\nNo successful backup for more than 26 hours.",
    )
  })

  it("escape the name and the worker's error, and shorten the error", () => {
    expect(backupAlerts.failed("R&D", link)).toBe(`<b>Backup failed on R&amp;D</b>\n${escapedLink}`)
    expect(backupAlerts.working("<prod>")).toBe("<b>Backups of &lt;prod&gt; are working again</b>")
    expect(backupAlerts.stale("<prod>", 1)).toContain("stale on &lt;prod&gt;</b>")
    expect(backupAlerts.failed("prod", "x".repeat(5000)).split("\n")[1]).toHaveLength(500)
  })
})

describe("alert texts", () => {
  it("stay within Telegram's 4096 characters whatever the input", () => {
    const huge = "<&>".repeat(5000)
    const probe = { ...failed(huge), url: huge }
    const texts = [
      healthAlerts.down(huge, probe),
      healthAlerts.up(huge),
      healthAlerts.workerDown(huge, probe),
      healthAlerts.workerUp(huge, huge),
      healthAlerts.backlog(huge, 1, 1),
      healthAlerts.backlogCleared(huge),
      backupAlerts.failed(huge, huge),
      backupAlerts.working(huge),
      backupAlerts.stale(huge, 1),
    ]
    for (const text of texts) expect(telegramPlainText(text).length).toBeLessThan(4096)
  })
})

describe("telegramPlainText", () => {
  it("reads an alert back as the text it was made from", () => {
    expect(telegramPlainText(healthAlerts.down("R&D <prod>", failed(link)))).toBe(
      `R&D <prod> is not responding · ${link}`,
    )
  })

  it("decodes each entity once, so literal entity text stays as written", () => {
    expect(telegramPlainText(backupAlerts.failed("a", "&lt; and &quot; and &amp;"))).toBe(
      "Backup failed on a · &lt; and &quot; and &amp;",
    )
  })

  it("joins lines with a dot", () => {
    expect(telegramPlainText("<b>one</b>\ntwo\nthree")).toBe("one · two · three")
  })
})

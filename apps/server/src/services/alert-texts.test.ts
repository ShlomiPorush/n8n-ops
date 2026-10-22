import { describe, expect, it, vi } from "vitest"
import type { Ctx } from "../context.ts"
import { backupItem } from "../routes/overview.ts"
import { backupAlerts } from "./backups.ts"
import { applyWorkerReport, healthAlerts, type ProbeResult, probeReport } from "./health.ts"
import type { Instance } from "./instances.ts"
import { clip, html, TelegramHtml, telegramPlainText } from "./telegram.ts"

const failed = (error?: string): ProbeResult => ({ ok: false, status: 503, ms: 12, error })
const link = '<a href="https://example.com">open</a> & more'
const escapedLink = "&lt;a href=&quot;https://example.com&quot;&gt;open&lt;/a&gt; &amp; more"
const text = (value: TelegramHtml) => String(value)

describe("health alert texts", () => {
  it("keep their wording for ordinary values", () => {
    expect(text(healthAlerts.down("prod", failed()))).toBe("<b>prod is not responding</b>\nHTTP 503")
    expect(text(healthAlerts.down("prod", failed("connect ECONNREFUSED")))).toBe(
      "<b>prod is not responding</b>\nconnect ECONNREFUSED",
    )
    expect(text(healthAlerts.up("prod"))).toBe("<b>prod is responding again</b>")
    expect(text(healthAlerts.workerDown("prod", { ...failed(), url: "http://w1:5678/healthz" }))).toBe(
      "<b>Worker down on prod</b>\nhttp://w1:5678/healthz: HTTP 503",
    )
    expect(text(healthAlerts.workerUp("prod", "http://w1:5678/healthz"))).toBe(
      "<b>Worker back on prod</b>\nhttp://w1:5678/healthz",
    )
    expect(text(healthAlerts.backlog("prod", 42, 10))).toBe(
      "<b>Queue backlog on prod</b>\n42 jobs waiting for more than 10 minutes",
    )
    expect(text(healthAlerts.backlogCleared("prod"))).toBe("<b>Queue backlog cleared on prod</b>")
  })

  it("escape names, URLs and errors, so no markup gets in", () => {
    expect(text(healthAlerts.down("R&D <prod>", failed(link)))).toBe(
      `<b>R&amp;D &lt;prod&gt; is not responding</b>\n${escapedLink}`,
    )
    expect(text(healthAlerts.workerDown("prod", { ...failed(link), url: "http://w1/?a=1&b=<2>" }))).toBe(
      `<b>Worker down on prod</b>\nhttp://w1/?a=1&amp;b=&lt;2&gt;: ${escapedLink}`,
    )
    expect(text(healthAlerts.workerUp("<i>x</i>", "http://w1/<b>"))).toBe(
      "<b>Worker back on &lt;i&gt;x&lt;/i&gt;</b>\nhttp://w1/&lt;b&gt;",
    )
    expect(text(healthAlerts.up("a&b"))).toBe("<b>a&amp;b is responding again</b>")
    expect(text(healthAlerts.backlog("a&b", 1, 1))).toContain("on a&amp;b</b>")
    expect(text(healthAlerts.backlogCleared("a&b"))).toBe("<b>Queue backlog cleared on a&amp;b</b>")
  })

  it("shorten long URLs and errors", () => {
    const alert = healthAlerts.workerDown("prod", { ...failed("e".repeat(5000)), url: `http://w/${"u".repeat(5000)}` })
    const [, line] = text(alert).split("\n")
    const [url, error] = (line ?? "").split(": ")
    expect(url).toHaveLength(200)
    expect(url?.endsWith("…")).toBe(true)
    expect(error).toHaveLength(500)
    expect(error?.endsWith("…")).toBe(true)
  })
})

describe("backup alert texts", () => {
  it("keep their wording for ordinary values", () => {
    expect(text(backupAlerts.failed("prod", "upload failed"))).toBe("<b>Backup failed on prod</b>\nupload failed")
    expect(text(backupAlerts.failed("prod"))).toBe("<b>Backup failed on prod</b>\n")
    expect(text(backupAlerts.working("prod"))).toBe("<b>Backups of prod are working again</b>")
    expect(text(backupAlerts.stale("prod", 26))).toBe(
      "<b>Backup is stale on prod</b>\nNo successful backup for more than 26 hours.",
    )
  })

  it("name the destination when only its copies are concerned", () => {
    expect(text(backupAlerts.failed("prod", "timeout", "NAS"))).toBe("<b>Backup failed on prod to NAS</b>\ntimeout")
    expect(text(backupAlerts.working("prod", "NAS & co"))).toBe(
      "<b>Backups of prod to NAS &amp; co are working again</b>",
    )
    expect(text(backupAlerts.stale("prod", 26, "S3"))).toContain("<b>Backup is stale on prod to S3</b>")
  })

  it("escape the name and the worker's error, and shorten the error", () => {
    expect(text(backupAlerts.failed("R&D", link))).toBe(`<b>Backup failed on R&amp;D</b>\n${escapedLink}`)
    expect(text(backupAlerts.working("<prod>"))).toBe("<b>Backups of &lt;prod&gt; are working again</b>")
    expect(text(backupAlerts.stale("<prod>", 1))).toContain("stale on &lt;prod&gt;</b>")
    expect(text(backupAlerts.failed("prod", "x".repeat(5000))).split("\n")[1]).toHaveLength(500)
  })
})

describe("alert texts", () => {
  it("stay within Telegram's 4096 characters whatever the input", () => {
    const huge = '<&>"'.repeat(5000)
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
    for (const alert of texts) expect(telegramPlainText(alert).length).toBeLessThan(4096)
  })
})

describe("html", () => {
  it("escapes every value, numbers too, and keeps the template's own markup", () => {
    expect(text(html`<b>${"<i>"}</b> ${42} ${'"q"'}`)).toBe("<b>&lt;i&gt;</b> 42 &quot;q&quot;")
  })

  it("puts Telegram HTML in as it is, so nothing is escaped twice", () => {
    const inner = html`<i>${"a&b"}</i>`
    expect(text(html`<b>${inner}</b>`)).toBe("<b><i>a&amp;b</i></b>")
    expect(text(TelegramHtml.join([inner, html`two`]))).toBe("<i>a&amp;b</i>\ntwo")
  })
})

describe("clip", () => {
  it("never cuts an emoji in half", () => {
    const clipped = clip(`${"a".repeat(498)}😀😀😀`, 500)
    expect(clipped).toBe(`${"a".repeat(498)}😀…`)
    expect(clipped).not.toMatch(/\p{Cs}/u) // no lone surrogate
    expect("😀".slice(0, 1)).toMatch(/\p{Cs}/u) // half an emoji is one
  })

  it("counts characters, not UTF-16 units", () => {
    expect(clip("😀".repeat(5), 5)).toBe("😀".repeat(5))
    expect(clip("😀".repeat(6), 5)).toBe(`${"😀".repeat(4)}…`)
  })
})

describe("telegramPlainText", () => {
  it("reads an alert back as the text it was made from", () => {
    expect(telegramPlainText(healthAlerts.down("R&D <prod>", failed(link)))).toBe(
      `R&D <prod> is not responding · ${link}`,
    )
  })

  it("reads any value back exactly", () => {
    for (const value of ['<a href="x">&amp;</a>', "&lt;&gt;&quot;&amp;", 'a & b < c > d " e', "&&amp;;"])
      expect(telegramPlainText(html`${value}`)).toBe(value)
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

describe("the Overview's backup item", () => {
  it("shows the alert as written", () => {
    const since = new Date("2026-10-21T10:00:00Z")
    const detail = String(backupAlerts.stale("R&D <prod>", 26))
    expect(backupItem({ id: "i1", name: "R&D <prod>" }, { detail, since })).toEqual({
      kind: "backup",
      id: "i1",
      name: "R&D <prod>",
      detail: "Backup is stale on R&D <prod> · No successful backup for more than 26 hours.",
      at: since,
    })
  })
})

describe("a worker's health report", () => {
  const probe = { ok: true, status: 200, ms: 5 }
  const report = {
    main: probe,
    readiness: probe,
    workers: [{ url: "http://w1/healthz", ...probe }],
    queue: null,
    checkedAt: "2026-10-21T10:00:00.000Z",
  }

  it("is accepted as the worker sends it", () => {
    expect(probeReport.safeParse(report).success).toBe(true)
    const withQueue = { ...report, queue: { waiting: 3, active: 1, completed: 9, failed: 0 }, metricsError: "x" }
    expect(probeReport.safeParse(withQueue).success).toBe(true)
  })

  it("is refused when a field has the wrong type, instead of breaking the health alerts", () => {
    const broken = {
      ...report,
      main: { ok: false, status: 0, ms: 1, error: { code: 1 } },
      workers: [{ ok: false, status: 0, ms: 1 }],
    }
    const parsed = probeReport.safeParse(broken)
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.map((i) => i.path.join("."))).toEqual(["main.error", "workers.0.url"])
  })

  // applyHealth starts by reading the instance's settings, so a call to it shows here as that read.
  const reached = new Error("applyHealth was called")
  const fakeCtx = () => {
    const warn = vi.fn()
    const forInstance = vi.fn(async () => {
      throw reached
    })
    return { ctx: { log: { warn }, settings: { forInstance } } as unknown as Ctx, warn, forInstance }
  }
  const instance = { id: "i1", name: "prod", overrides: {} } as unknown as Instance

  it("reaches the health alerts when it fits", async () => {
    const { ctx, warn } = fakeCtx()
    await expect(applyWorkerReport(ctx, instance, report, "w")).rejects.toBe(reached)
    expect(warn).not.toHaveBeenCalled()
  })

  it("is logged and skipped when it does not fit", async () => {
    const { ctx, warn, forInstance } = fakeCtx()
    const broken = { ...report, main: { ok: false, status: 0, ms: 1, error: { code: 1 } } }
    await expect(applyWorkerReport(ctx, instance, broken, "w")).resolves.toBeUndefined()
    expect(forInstance).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith("worker sent an invalid health report", {
      instance: "prod",
      worker: "w",
      issues: [expect.stringMatching(/^main\.error: /)],
    })
  })
})

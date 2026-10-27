import { type DateWriting, formatWindow, messageWriting } from "@n8n-ops/shared"
import { and, count, desc, eq, gt, isNull, lte } from "drizzle-orm"
import nodemailer from "nodemailer"
import type { Ctx } from "../context.ts"
import { alertOutbox, alertState, backupRuns, failures, instances, problems } from "../db/schema.ts"
import { emailAccount } from "./draft-tests.ts"
import { type Email, formatDate, panel, plural, render, stats, type Tone, table, tag } from "./email-layout.ts"
import { compareVersions, latestN8nVersion } from "./instances.ts"
import { telegramPlainText } from "./telegram.ts"

const n = (value: number) => value.toLocaleString("en-US")

/** How far back each report counts. */
const periodMs = { daily: 86_400_000, weekly: 7 * 86_400_000 } as const

export type Report = Email

type ReportData = {
  period: "daily" | "weekly"
  openByInstance: { name: string; open: number }[]
  topWorkflows: { workflow: string; instance: string; failures: number }[]
  incidents: { at: Date; text: string }[]
  backups: { name: string; status: string; at: Date | null }[]
  versions: { name: string; version: string | null }[]
  latest: string | null
  /** How dates are written: the zone and formats of Settings → General (`messageWriting`, EM-6). */
  dates?: DateWriting
  /** When the report is made: the end of the window it counts. */
  when?: Date
  /** The start of that window; a day or a week before `when` when left out. */
  since?: Date
  /** Sent by the test button in Settings → Email Reports, not on the schedule. */
  test?: boolean
}

/** What the report the test button sends says about itself. */
const TEST_NOTE = "This is a test sent from Settings → Email Reports."

const backupWords: Record<string, [string, Tone]> = {
  ok: ["OK", "ok"],
  partial: ["Some copies failed", "warn"],
  failed: ["Failed", "fail"],
  running: ["Running", "info"],
  none: ["Never", "muted"],
}

/** The daily or weekly summary: what needs a look first, then the details, in the console's layout. */
export function renderReport(d: ReportData): Report {
  const dates = d.dates ?? messageWriting(undefined)
  const when = d.when ?? new Date()
  const since = d.since ?? new Date(when.getTime() - periodMs[d.period])
  // The exact window the failures and incidents are counted in, with its zone (EM-6).
  const span = formatWindow(since, when, dates)
  const title = `n8n-ops ${d.period} report`
  const totalOpen = d.openByInstance.reduce((n, i) => n + i.open, 0)
  const instancesWithOpen = d.openByInstance.filter((i) => i.open > 0)
  const behind = d.latest
    ? d.versions.filter((v) => v.version && compareVersions(v.version, d.latest as string) < 0)
    : []
  const badBackups = d.backups.filter((b) => b.status === "failed" || b.status === "partial" || b.status === "none")
  const stamp = (at: Date | null) => (at ? formatDate(at, dates, true) : "never")
  const sections: { title: string; rows: string[][] }[] = [
    { title: `Open problems: ${totalOpen}`, rows: instancesWithOpen.map((i) => [i.name, String(i.open)]) },
    {
      title: "Top failing workflows",
      rows: d.topWorkflows.map((w) => [w.workflow, w.instance, plural(w.failures, "failure")]),
    },
    { title: "Health alerts", rows: d.incidents.map((i) => [stamp(i.at), i.text]) },
    { title: "Backups", rows: d.backups.map((b) => [b.name, backupWords[b.status]?.[0] ?? b.status, stamp(b.at)]) },
    {
      title: d.latest ? `Versions (latest n8n ${d.latest})` : "Versions",
      rows: (behind.length ? behind : d.versions).map((v) => [v.name, v.version ?? "unknown"]),
    },
  ]
  const text = [
    title,
    span,
    "",
    ...sections.flatMap((s) => [
      s.title,
      ...(s.rows.length ? s.rows.map((r) => `  ${r.join("  ·  ")}`) : ["  none"]),
      "",
    ]),
    ...(d.test ? [TEST_NOTE] : []),
  ].join("\n")

  const needsLook = totalOpen > 0 || badBackups.length > 0 || d.incidents.length > 0
  const html = render({
    title:
      totalOpen > 0
        ? `${plural(totalOpen, "open problem")} on ${plural(instancesWithOpen.length, "instance")}`
        : "No open problems",
    topic: d.period === "daily" ? "Daily report" : "Weekly report",
    tone: totalOpen > 0 || badBackups.length ? "fail" : d.incidents.length || behind.length ? "warn" : "ok",
    intro: `${span}, on every n8n instance.${needsLook ? "" : " Nothing needs a look."}`,
    when,
    dates,
    blocks: [
      stats([
        { label: "Open problems", value: n(totalOpen), tone: totalOpen ? "fail" : undefined },
        { label: "Health alerts", value: n(d.incidents.length), tone: d.incidents.length ? "warn" : undefined },
        {
          label: "Backups to check",
          value: n(badBackups.length),
          tone: badBackups.length ? "fail" : undefined,
          note: `of ${plural(d.backups.length, "instance")}`,
        },
      ]),
      panel(
        "Top failing workflows",
        [
          table(
            ["Workflow", "Instance", ["Failures", "right"]],
            d.topWorkflows.map((w) => [w.workflow, w.instance, n(w.failures)]),
            { empty: "No workflow failed." },
          ),
        ],
        { count: d.topWorkflows.length || undefined },
      ),
      panel(
        "Open problems",
        [
          table(
            ["Instance", ["Open", "right"]],
            instancesWithOpen.map((i) => [i.name, n(i.open)]),
            { empty: "No open problems." },
          ),
        ],
        { count: totalOpen || undefined },
      ),
      panel(
        "Health alerts",
        [
          table(
            ["When", "What"],
            d.incidents.map((i) => [stamp(i.at), i.text]),
            { empty: "No health alerts." },
          ),
        ],
        { count: d.incidents.length || undefined },
      ),
      panel("Backups", [
        table(
          ["Instance", "Last backup", ["When", "right"]],
          d.backups.map((b) => {
            const [word, t] = backupWords[b.status] ?? [b.status, "muted" as Tone]
            return [b.name, tag(word, t), stamp(b.at)]
          }),
          { empty: "No instances." },
        ),
      ]),
      panel(
        "Versions",
        [
          table(
            ["Instance", ["n8n", "right"]],
            (behind.length ? behind : d.versions).map((v) => [v.name, v.version ?? "unknown"]),
            { empty: "No instances." },
          ),
        ],
        {
          note: d.latest
            ? behind.length
              ? `${plural(behind.length, "instance is", "instances are")} behind n8n ${d.latest}.`
              : `Every instance with a known version runs n8n ${d.latest} or later.`
            : undefined,
        },
      ),
    ],
    footer: d.test
      ? TEST_NOTE
      : `You get this because the ${d.period} report is on in Settings → Email Reports.`,
  })
  return { subject: `${d.test ? "Test: " : ""}${title}: ${plural(totalOpen, "open problem")}`, text, html }
}

/**
 * The report of the day or week that ends at `when`. Every query counts what happened after `since` up to and
 * including `when`, the window the report prints (EM-6): what arrives while the report is being made waits for
 * the next one. `test` marks the one the test button sends, so its footer says so.
 */
export async function buildReport(
  ctx: Ctx,
  period: "daily" | "weekly",
  when = new Date(),
  { test = false } = {},
): Promise<Report> {
  const since = new Date(when.getTime() - periodMs[period])
  const allInstances = await ctx.db.select().from(instances)
  const name = new Map(allInstances.map((i) => [i.id, i.name]))
  const open = await ctx.db
    .select({ instanceId: problems.instanceId, n: count() })
    .from(problems)
    .where(and(eq(problems.status, "open"), isNull(problems.mergedInto), lte(problems.createdAt, when)))
    .groupBy(problems.instanceId)
  const top = await ctx.db
    .select({ workflow: problems.workflowName, instanceId: problems.instanceId, n: count() })
    .from(failures)
    .innerJoin(problems, eq(failures.problemId, problems.id))
    .where(and(gt(failures.createdAt, since), lte(failures.createdAt, when)))
    .groupBy(problems.workflowName, problems.instanceId)
    .orderBy(desc(count()))
    .limit(10)
  const incidents = await ctx.db
    .select({ at: alertOutbox.createdAt, text: alertOutbox.text })
    .from(alertOutbox)
    .where(and(eq(alertOutbox.kind, "health"), gt(alertOutbox.createdAt, since), lte(alertOutbox.createdAt, when)))
    .orderBy(desc(alertOutbox.createdAt))
    .limit(30)
  const backups = await Promise.all(
    allInstances.map(async (i) => {
      const [last] = await ctx.db
        .select()
        .from(backupRuns)
        .where(and(eq(backupRuns.instanceId, i.id), lte(backupRuns.startedAt, when)))
        .orderBy(desc(backupRuns.startedAt))
        .limit(1)
      return { name: i.name, status: last?.status ?? "none", at: last?.startedAt ?? null }
    }),
  )
  return renderReport({
    period,
    openByInstance: allInstances.map((i) => ({ name: i.name, open: open.find((o) => o.instanceId === i.id)?.n ?? 0 })),
    topWorkflows: top.map((t) => ({ workflow: t.workflow, instance: name.get(t.instanceId) ?? "?", failures: t.n })),
    incidents: incidents.map((i) => ({ at: i.at, text: telegramPlainText(i.text) })),
    backups,
    versions: allInstances.map((i) => ({ name: i.name, version: i.version })),
    latest: await latestN8nVersion(),
    dates: messageWriting(await ctx.settings.get("general")),
    when,
    since,
    test,
  })
}

/**
 * Sends an email with the stored Email settings, or for a test with the values on screen over them (`draft`,
 * FS-19; see emailAccount for which password goes where). Returns who it was sent to.
 */
export async function sendEmail(ctx: Ctx, report: Report, draft: Record<string, unknown> = {}) {
  const account = emailAccount(await ctx.settings.get("email"), draft, (enc) => ctx.secrets.decrypt(enc))
  const { from, recipients, ...server } = account
  const transport = nodemailer.createTransport(server)
  await transport.sendMail(mailOptions(report, from, recipients))
  return recipients
}

/** One message to every recipient, with a plain text part beside the HTML (EM-1, EM-6). */
export function mailOptions(report: Report, from: string, recipients: string[]) {
  return {
    from,
    to: recipients.join(", "),
    subject: report.subject,
    text: report.text,
    html: report.html,
    // SMTP allows 998 characters per line, and a server breaks a longer line wherever it likes, even in the
    // middle of an HTML tag; base64 keeps every line short (EM-3).
    textEncoding: "base64" as const,
  }
}

/** Local date parts in the configured time zone. */
export function zonedParts(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  )
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(parts.weekday))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday }
}

/** Sends the daily and weekly reports when their time comes (checked every minute). */
export async function maybeSendReports(ctx: Ctx, now = new Date()) {
  const email = await ctx.settings.get("email")
  if (!email.dailyEnabled && !email.weeklyEnabled) return
  const { timezone } = await ctx.settings.get("general")
  const local = zonedParts(now, timezone || "UTC")
  const due: ("daily" | "weekly")[] = []
  if (email.dailyEnabled && local.time >= email.dailyTime) due.push("daily")
  if (email.weeklyEnabled && local.weekday === email.weeklyDay && local.time >= email.weeklyTime) due.push("weekly")
  for (const period of due) {
    const key = `report:${period}:${local.date}`
    const [sent] = await ctx.db.select().from(alertState).where(eq(alertState.key, key))
    if (sent) continue
    await ctx.db.insert(alertState).values({ key, active: false, detail: "sent" }).onConflictDoNothing()
    try {
      await sendEmail(ctx, await buildReport(ctx, period, now))
      ctx.log.info("report sent", { period })
    } catch (error) {
      ctx.log.error("report failed", { period, error: (error as Error).message })
      await ctx.db.delete(alertState).where(eq(alertState.key, key))
    }
  }
}

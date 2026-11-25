import { type DateWriting, formatWindow, messageWriting } from "@n8n-ops/shared"
import { and, count, desc, eq, gt, lte } from "drizzle-orm"
import nodemailer from "nodemailer"
import type { Ctx } from "../context.ts"
import { affectedWorkflows, alertOutbox, alertState, backupRuns, failures, instances } from "../db/schema.ts"
import { emailAccount, noEncryption } from "./draft-tests.ts"
import { type Email, formatDate, panel, plural, render, stats, type Tone, table, tag } from "./email-layout.ts"
import { activeOnly, can, compareVersions, latestN8nVersion } from "./instances.ts"
import { openProblemCount, openProblemsByInstance } from "./problem-view.ts"
import { telegramPlainText } from "./telegram.ts"

const n = (value: number) => value.toLocaleString("en-US")

const periodMs = { daily: 86_400_000, weekly: 7 * 86_400_000 } as const

export type Report = Email

type ReportData = {
  period: "daily" | "weekly"
  openByInstance: { name: string; open: number }[]
  totalOpen?: number
  topWorkflows: { workflow: string; instance: string; failures: number }[]
  incidents: { at: Date; text: string }[]
  backups: { name: string; status: string; at: Date | null }[]
  versions: { name: string; version: string | null }[]
  latest: string | null
  dates?: DateWriting
  when?: Date
  since?: Date
  test?: boolean
}

const TEST_NOTE = "This is a test sent from Settings → Email Reports."

const backupWords: Record<string, [string, Tone]> = {
  ok: ["OK", "ok"],
  partial: ["Some copies failed", "warn"],
  failed: ["Failed", "fail"],
  running: ["Running", "info"],
  none: ["Never", "muted"],
}

export function renderReport(d: ReportData): Report {
  const dates = d.dates ?? messageWriting(undefined)
  const when = d.when ?? new Date()
  const since = d.since ?? new Date(when.getTime() - periodMs[d.period])
  const span = formatWindow(since, when, dates)
  const title = `n8n-ops ${d.period} report`
  const totalOpen = d.totalOpen ?? d.openByInstance.reduce((n, i) => n + i.open, 0)
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
    footer: d.test ? TEST_NOTE : `You get this because the ${d.period} report is on in Settings → Email Reports.`,
  })
  return { subject: `${d.test ? "Test: " : ""}${title}: ${plural(totalOpen, "open problem")}`, text, html }
}

export async function buildReport(
  ctx: Ctx,
  period: "daily" | "weekly",
  when = new Date(),
  { test = false } = {},
): Promise<Report> {
  const since = new Date(when.getTime() - periodMs[period])
  const allInstances = await ctx.db.select().from(instances).where(activeOnly)
  const name = new Map(allInstances.map((i) => [i.id, i.name]))
  const open = await openProblemsByInstance(ctx, when)
  const totalOpen = await openProblemCount(ctx, { before: when })
  const top = await ctx.db
    .select({ workflow: affectedWorkflows.workflowName, instanceId: affectedWorkflows.instanceId, n: count() })
    .from(failures)
    .innerJoin(affectedWorkflows, eq(failures.affectedWorkflowId, affectedWorkflows.id))
    .where(and(gt(failures.createdAt, since), lte(failures.createdAt, when)))
    .groupBy(affectedWorkflows.workflowName, affectedWorkflows.instanceId)
    .orderBy(desc(count()))
    .limit(10)
  const incidents = await ctx.db
    .select({ at: alertOutbox.createdAt, text: alertOutbox.text })
    .from(alertOutbox)
    .where(and(eq(alertOutbox.kind, "health"), gt(alertOutbox.createdAt, since), lte(alertOutbox.createdAt, when)))
    .orderBy(desc(alertOutbox.createdAt))
    .limit(30)
  const backups = await Promise.all(
    allInstances
      .filter((i) => can(i, "backup"))
      .map(async (i) => {
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
    totalOpen,
    openByInstance: allInstances.map((i) => ({ name: i.name, open: open.find((o) => o.instanceId === i.id)?.n ?? 0 })),
    topWorkflows: top.map((t) => ({ workflow: t.workflow, instance: name.get(t.instanceId) ?? "?", failures: t.n })),
    incidents: incidents.map((i) => ({ at: i.at, text: telegramPlainText(i.text) })),
    backups,
    versions: allInstances.map((i) => ({ name: i.name, version: i.version })),
    latest: await latestN8nVersion(ctx),
    dates: messageWriting(await ctx.settings.get("general")),
    when,
    since,
    test,
  })
}

export async function sendEmail(ctx: Ctx, report: Report, draft: Record<string, unknown> = {}) {
  const { smtpAllowUnencrypted: _, ...screen } = draft
  const typed = ctx.settings.fromEnv().smtpAllowUnencrypted === undefined ? draft : screen
  const account = emailAccount(await ctx.settings.get("email"), typed, (enc) => ctx.secrets.decrypt(enc))
  const { from, recipients, ...server } = account
  const transport = nodemailer.createTransport(server)
  try {
    await transport.sendMail(mailOptions(report, from, recipients))
  } catch (error) {
    if ((error as { code?: string }).code === "ETLS") (error as Error).message = noEncryption
    throw error
  }
  return recipients
}

export function mailOptions(report: Report, from: string, recipients: string[]) {
  return {
    from,
    to: recipients.join(", "),
    subject: report.subject,
    text: report.text,
    html: report.html,
    textEncoding: "base64" as const,
  }
}

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
    const [claimed] = await ctx.db
      .insert(alertState)
      .values({ key, active: false, detail: "sent" })
      .onConflictDoNothing()
      .returning({ key: alertState.key })
    if (!claimed) continue
    try {
      await sendEmail(ctx, await buildReport(ctx, period, now))
      ctx.log.info("report sent", { period })
    } catch (error) {
      ctx.log.error("report failed", { period, error: (error as Error).message })
      await ctx.db.delete(alertState).where(eq(alertState.key, key))
    }
  }
}

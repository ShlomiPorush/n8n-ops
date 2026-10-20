import { and, count, desc, eq, gt, isNull } from "drizzle-orm"
import nodemailer from "nodemailer"
import type { Ctx } from "../context.ts"
import { alertOutbox, alertState, backupRuns, failures, instances, problems } from "../db/schema.ts"
import { type Email, formatDate, panel, plural, render, stats, type Tone, table, tag } from "./email-layout.ts"
import { compareVersions, latestN8nVersion } from "./instances.ts"

const n = (value: number) => value.toLocaleString("en-US")

export type Report = Email

type ReportData = {
  period: "daily" | "weekly"
  openByInstance: { name: string; open: number }[]
  topWorkflows: { workflow: string; instance: string; failures: number }[]
  incidents: { at: Date; text: string }[]
  backups: { name: string; status: string; at: Date | null }[]
  versions: { name: string; version: string | null }[]
  latest: string | null
  /** The time zone set in Settings → General; dates read day/month/year in it. */
  timeZone?: string
  when?: Date
}

const backupWords: Record<string, [string, Tone]> = {
  ok: ["OK", "ok"],
  failed: ["Failed", "fail"],
  running: ["Running", "info"],
  none: ["Never", "muted"],
}

/** The daily or weekly summary: what needs a look first, then the details, in the console's layout. */
export function renderReport(d: ReportData): Report {
  const timeZone = d.timeZone || "UTC"
  const when = d.when ?? new Date()
  const title = `n8n-ops ${d.period} report`
  const totalOpen = d.openByInstance.reduce((n, i) => n + i.open, 0)
  const instancesWithOpen = d.openByInstance.filter((i) => i.open > 0)
  const behind = d.latest
    ? d.versions.filter((v) => v.version && compareVersions(v.version, d.latest as string) < 0)
    : []
  const badBackups = d.backups.filter((b) => b.status === "failed" || b.status === "none")
  const stamp = (at: Date | null) => (at ? formatDate(at, timeZone, true) : "never")
  const sections: { title: string; rows: string[][] }[] = [
    { title: `Open problems: ${totalOpen}`, rows: instancesWithOpen.map((i) => [i.name, String(i.open)]) },
    {
      title: "Top failing workflows",
      rows: d.topWorkflows.map((w) => [w.workflow, w.instance, plural(w.failures, "failure")]),
    },
    { title: "Health incidents", rows: d.incidents.map((i) => [stamp(i.at), i.text]) },
    { title: "Backups", rows: d.backups.map((b) => [b.name, backupWords[b.status]?.[0] ?? b.status, stamp(b.at)]) },
    {
      title: d.latest ? `Versions (latest n8n ${d.latest})` : "Versions",
      rows: (behind.length ? behind : d.versions).map((v) => [v.name, v.version ?? "unknown"]),
    },
  ]
  const text = [
    title,
    "",
    ...sections.flatMap((s) => [
      s.title,
      ...(s.rows.length ? s.rows.map((r) => `  ${r.join("  ·  ")}`) : ["  none"]),
      "",
    ]),
  ].join("\n")

  const needsLook = totalOpen > 0 || badBackups.length > 0 || d.incidents.length > 0
  const html = render({
    title:
      totalOpen > 0
        ? `${plural(totalOpen, "open problem")} on ${plural(instancesWithOpen.length, "instance")}`
        : "No open problems",
    topic: d.period === "daily" ? "Daily report" : "Weekly report",
    tone: totalOpen > 0 || badBackups.length ? "fail" : d.incidents.length || behind.length ? "warn" : "ok",
    intro: `${d.period === "daily" ? "The last 24 hours" : "The last 7 days"} on every n8n instance.${needsLook ? "" : " Nothing needs a look."}`,
    when,
    timeZone,
    blocks: [
      stats([
        { label: "Open problems", value: n(totalOpen), tone: totalOpen ? "fail" : undefined },
        { label: "Health incidents", value: n(d.incidents.length), tone: d.incidents.length ? "warn" : undefined },
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
        "Health incidents",
        [
          table(
            ["When", "What"],
            d.incidents.map((i) => [stamp(i.at), i.text]),
            { empty: "No incidents." },
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
              : `Every instance runs n8n ${d.latest} or later.`
            : undefined,
        },
      ),
    ],
    footer: `You get this because the ${d.period} report is on in Settings → Email Reports.`,
  })
  return { subject: `${title}: ${plural(totalOpen, "open problem")}`, text, html }
}

/** Telegram HTML as plain text: tags dropped, entities read back, lines joined. */
const plainText = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\n/g, " · ")

export async function buildReport(ctx: Ctx, period: "daily" | "weekly"): Promise<Report> {
  const since = new Date(Date.now() - (period === "daily" ? 1 : 7) * 86_400_000)
  const allInstances = await ctx.db.select().from(instances)
  const name = new Map(allInstances.map((i) => [i.id, i.name]))
  const open = await ctx.db
    .select({ instanceId: problems.instanceId, n: count() })
    .from(problems)
    .where(and(eq(problems.status, "open"), isNull(problems.mergedInto)))
    .groupBy(problems.instanceId)
  const top = await ctx.db
    .select({ workflow: problems.workflowName, instanceId: problems.instanceId, n: count() })
    .from(failures)
    .innerJoin(problems, eq(failures.problemId, problems.id))
    .where(gt(failures.createdAt, since))
    .groupBy(problems.workflowName, problems.instanceId)
    .orderBy(desc(count()))
    .limit(10)
  const incidents = await ctx.db
    .select({ at: alertOutbox.createdAt, text: alertOutbox.text })
    .from(alertOutbox)
    .where(and(eq(alertOutbox.kind, "health"), gt(alertOutbox.createdAt, since)))
    .orderBy(desc(alertOutbox.createdAt))
    .limit(30)
  const backups = await Promise.all(
    allInstances.map(async (i) => {
      const [last] = await ctx.db
        .select()
        .from(backupRuns)
        .where(eq(backupRuns.instanceId, i.id))
        .orderBy(desc(backupRuns.startedAt))
        .limit(1)
      return { name: i.name, status: last?.status ?? "none", at: last?.startedAt ?? null }
    }),
  )
  return renderReport({
    period,
    openByInstance: allInstances.map((i) => ({ name: i.name, open: open.find((o) => o.instanceId === i.id)?.n ?? 0 })),
    topWorkflows: top.map((t) => ({ workflow: t.workflow, instance: name.get(t.instanceId) ?? "?", failures: t.n })),
    incidents: incidents.map((i) => ({ at: i.at, text: plainText(i.text) })),
    backups,
    versions: allInstances.map((i) => ({ name: i.name, version: i.version })),
    latest: await latestN8nVersion(),
    timeZone: (await ctx.settings.get("general")).timezone || "UTC",
  })
}

export async function sendEmail(ctx: Ctx, report: Report) {
  const email = await ctx.settings.get("email")
  if (!email.smtpHost || !email.recipients.length)
    throw new Error("Email is not configured: set the SMTP server and recipients.")
  const transport = nodemailer.createTransport({
    host: email.smtpHost,
    port: email.smtpPort,
    secure: email.smtpSecure,
    auth: email.smtpUser
      ? { user: email.smtpUser, pass: email.smtpPasswordEnc ? ctx.secrets.decrypt(email.smtpPasswordEnc) : "" }
      : undefined,
  })
  await transport.sendMail(mailOptions(report, email.from || email.smtpUser, email.recipients))
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
      await sendEmail(ctx, await buildReport(ctx, period))
      ctx.log.info("report sent", { period })
    } catch (error) {
      ctx.log.error("report failed", { period, error: (error as Error).message })
      await ctx.db.delete(alertState).where(eq(alertState.key, key))
    }
  }
}

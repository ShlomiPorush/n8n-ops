import { and, count, desc, eq, gt, isNull } from "drizzle-orm"
import nodemailer from "nodemailer"
import type { Ctx } from "../context.ts"
import { alertOutbox, alertState, backupRuns, failures, instances, problems } from "../db/schema.ts"
import { compareVersions, latestN8nVersion } from "./instances.ts"
import { escapeHtml } from "./telegram.ts"

export type Report = { subject: string; text: string; html: string }

type ReportData = {
  period: "daily" | "weekly"
  openByInstance: { name: string; open: number }[]
  topWorkflows: { workflow: string; instance: string; failures: number }[]
  incidents: { at: Date; text: string }[]
  backups: { name: string; status: string; at: Date | null }[]
  versions: { name: string; version: string | null }[]
  latest: string | null
}

export function renderReport(d: ReportData): Report {
  const title = `n8n-ops ${d.period} report`
  const totalOpen = d.openByInstance.reduce((n, i) => n + i.open, 0)
  const behind = d.latest
    ? d.versions.filter((v) => v.version && compareVersions(v.version, d.latest as string) < 0)
    : []
  const sections: { title: string; rows: string[][] }[] = [
    {
      title: `Open problems: ${totalOpen}`,
      rows: d.openByInstance.filter((i) => i.open > 0).map((i) => [i.name, String(i.open)]),
    },
    {
      title: "Top failing workflows",
      rows: d.topWorkflows.map((w) => [w.workflow, w.instance, `${w.failures} failures`]),
    },
    {
      title: "Health incidents",
      rows: d.incidents.map((i) => [i.at.toISOString().slice(0, 16).replace("T", " "), i.text]),
    },
    {
      title: "Backups",
      rows: d.backups.map((b) => [
        b.name,
        b.status,
        b.at ? b.at.toISOString().slice(0, 16).replace("T", " ") : "never",
      ]),
    },
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
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#111">
<h2 style="margin:0 0 16px">${escapeHtml(title)}</h2>
${sections
  .map(
    (s) =>
      `<h3 style="margin:20px 0 6px">${escapeHtml(s.title)}</h3>${
        s.rows.length
          ? `<table style="border-collapse:collapse">${s.rows
              .map(
                (r) =>
                  `<tr>${r.map((c) => `<td style="padding:3px 14px 3px 0;border-bottom:1px solid #eee">${escapeHtml(c)}</td>`).join("")}</tr>`,
              )
              .join("")}</table>`
          : `<p style="color:#666;margin:0">None</p>`
      }`,
  )
  .join("\n")}
</div>`
  return { subject: `${title}: ${totalOpen} open problems`, text, html }
}

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
    incidents: incidents.map((i) => ({ at: i.at, text: i.text.replace(/<[^>]+>/g, "").replace(/\n/g, " · ") })),
    backups,
    versions: allInstances.map((i) => ({ name: i.name, version: i.version })),
    latest: await latestN8nVersion(),
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
  await transport.sendMail({
    from: email.from || email.smtpUser,
    to: email.recipients.join(", "),
    subject: report.subject,
    text: report.text,
    html: report.html,
  })
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

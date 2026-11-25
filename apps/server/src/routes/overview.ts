import { and, count, desc, eq, gt, inArray, isNull, like, or, sql } from "drizzle-orm"
import { Hono } from "hono"
import type { Ctx } from "../context.ts"
import {
  accessRequests,
  affectedWorkflows,
  alertState,
  apiTokens,
  backupRuns,
  instances,
  problems,
  workers,
} from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import type { Env } from "../http/types.ts"
import { instancesOf } from "../services/access.ts"
import { currentHealth, WORKER_ONLINE_MS } from "../services/collection.ts"
import { activeOnly, activeWith, can } from "../services/instances.ts"
import { openProblemCount, problemItems } from "../services/problem-view.ts"
import { telegramPlainText } from "../services/telegram.ts"

export { WORKER_ONLINE_MS }
export const PROBLEMS_SHOWN = 50
export const SOURCE_TIMEOUT_MS = 8_000

export type Tone = "fail" | "warn" | "info"

export const attentionSources = ["access", "problems", "instances", "backups", "workers"] as const
export type AttentionSource = (typeof attentionSources)[number]

export type AttentionItem = { tone: Tone } & (
  | {
      kind: "problem"
      id: string
      status: "open"
      reason: "new" | "regression"
      workflowName: string
      instanceName: string
      errorMessage: string
      title: string
      hint: string | null
      count: number
      workflows: number
      affectedTotal: number
      instances: string[]
      at: Date
    }
  | { kind: "instance"; id: string; name: string; health: string; detail: string; at: Date | null }
  | { kind: "backup"; id: string; name: string; detail: string; running: boolean; at: Date | null }
  | { kind: "worker"; id: string; name: string; at: Date | null }
  | { kind: "access"; id: string; name: string; agent: string; detail: string; at: Date | null; revision: number }
)

export type UncheckedItem = {
  kind: "health" | "failures"
  id: string
  name: string
  detail: string
  at: Date | null
}

export type Attention = {
  items: AttentionItem[]
  total: number
  tone: Tone | null
  moreProblems: number
  unchecked: UncheckedItem[]
  failed: AttentionSource[]
}

type Part = { items: AttentionItem[]; total: number; tone: Tone | null; unchecked?: UncheckedItem[] }

const rank: Record<Tone, number> = { fail: 0, warn: 1, info: 2 }

export function worstTone(tones: Iterable<Tone | null | undefined>): Tone | null {
  let worst: Tone | null = null
  for (const t of tones) if (t && (!worst || rank[t] < rank[worst])) worst = t
  return worst
}

const listed = (items: AttentionItem[]): Part => ({
  items,
  total: items.length,
  tone: worstTone(items.map((i) => i.tone)),
})

export function combine(parts: [AttentionSource, Part | null][]): Attention {
  const read = parts.flatMap(([, p]) => (p ? [p] : []))
  const time = (i: { at: Date | null }) => i.at?.getTime() ?? 0
  const items = read.flatMap((p) => p.items).sort((a, b) => rank[a.tone] - rank[b.tone] || time(b) - time(a))
  const total = read.reduce((sum, p) => sum + p.total, 0)
  return {
    items,
    total,
    tone: worstTone(read.map((p) => p.tone)),
    moreProblems: read.reduce((sum, p) => sum + p.total - p.items.length, 0),
    unchecked: read.flatMap((p) => p.unchecked ?? []),
    failed: parts.flatMap(([source, p]) => (p ? [] : [source])),
  }
}

type Reading = {
  main?: { error?: string }
  readiness?: { ok: boolean }
  backlogActive?: boolean
  workers?: { ok: boolean; state?: string }[]
  discovery?: { status: string; found: number }
} | null

export function instanceDetail(health: "down" | "warn", d: Reading): string {
  if (health === "down") return `Down${d?.main?.error ? `: ${d.main.error}` : ""}`
  if (d?.backlogActive) return "Queue backlog"
  const wrong = d?.workers?.filter((w) => !w.ok) ?? []
  if (wrong.some((w) => w.state === "down" || w.state === "unreachable")) return "Queue worker down"
  if (wrong.length) return "Queue worker needs a look"
  if (d?.readiness?.ok === false) return "Not ready"
  const found = d?.discovery
  if (found?.status === "ok" && found.found === 0) return "No queue worker found"
  if (found?.status === "partial") return "Queue workers not all checked"
  if (found && found.status !== "ok") return "Queue workers could not be listed"
  return "Needs a look"
}

export function backupItem(
  instance: Pick<typeof instances.$inferSelect, "id" | "name">,
  state: Pick<typeof alertState.$inferSelect, "detail" | "since">,
) {
  return {
    kind: "backup" as const,
    id: instance.id,
    name: instance.name,
    detail: telegramPlainText(state.detail ?? ""),
    at: state.since,
  }
}

async function accessPart(ctx: Ctx): Promise<Part> {
  const waiting = await ctx.db
    .select({ r: accessRequests, tokenName: apiTokens.name })
    .from(accessRequests)
    .innerJoin(apiTokens, eq(accessRequests.tokenId, apiTokens.id))
    .where(and(eq(accessRequests.status, "pending"), gt(accessRequests.decideBy, new Date())))
    .orderBy(desc(accessRequests.requestedAt))
  const children = await instancesOf(
    ctx.db,
    waiting.map((w) => w.r.id),
  )
  return listed(
    waiting.map(({ r, tokenName }) => {
      const asked = (children.get(r.id) ?? []).filter((c) => c.requestedScopes !== null)
      const first = asked[0]?.instanceName ?? "?"
      return {
        kind: "access",
        tone: "warn",
        id: r.id,
        name: asked.length > 1 ? `${first} +${asked.length - 1}` : first,
        agent: tokenName,
        detail: `${tokenName} asks for access: ${r.reason}`,
        at: r.requestedAt,
        revision: r.revision,
      }
    }),
  )
}

async function problemsPart(ctx: Ctx): Promise<Part> {
  const dayAgo = new Date(Date.now() - 86_400_000)
  const eligible = ctx.db
    .select({
      problemId: affectedWorkflows.problemId,
      regression: sql<boolean>`bool_or(${affectedWorkflows.regression})`.as("e_regression"),
      at: sql<Date>`max(${affectedWorkflows.lastSeen})`.as("e_at"),
    })
    .from(affectedWorkflows)
    .where(
      and(
        eq(affectedWorkflows.status, "open"),
        gt(affectedWorkflows.lastSeen, dayAgo),
        or(eq(affectedWorkflows.regression, true), gt(affectedWorkflows.firstSeen, dayAgo)),
      ),
    )
    .groupBy(affectedWorkflows.problemId)
    .as("e")
  const shown = await ctx.db
    .select({
      id: problems.id,
      regression: eligible.regression,
      at: eligible.at,
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(problems)
    .innerJoin(eligible, eq(eligible.problemId, problems.id))
    .where(isNull(problems.mergedInto))
    .orderBy(desc(eligible.at), desc(problems.id))
    .limit(PROBLEMS_SHOWN)
  const total = shown[0]?.total ?? 0
  const items = await problemItems(
    ctx,
    shown.map((p) => p.id),
    1,
  )
  return {
    items: shown.flatMap(({ id, regression, at }) => {
      const p = items.get(id)
      const first = p?.affectedWorkflows[0]
      if (!p || !first) return []
      return [
        {
          kind: "problem" as const,
          tone: "fail" as const,
          id,
          status: "open" as const,
          reason: regression ? ("regression" as const) : ("new" as const),
          workflowName: first.workflowName,
          instanceName: first.instanceName,
          errorMessage: p.errorMessage,
          title: p.title,
          hint: p.hint,
          count: p.count,
          workflows: p.workflows,
          affectedTotal: p.affectedTotal,
          instances: p.instances,
          at: new Date(at),
        },
      ]
    }),
    total,
    tone: total ? "fail" : null,
  }
}

async function instancesPart(ctx: Ctx): Promise<Part> {
  const all = await ctx.db.select().from(instances).where(activeOnly)
  const now = await currentHealth(ctx, all)
  const items: AttentionItem[] = []
  const unchecked: UncheckedItem[] = []
  for (const row of all) {
    const known = now.get(row.id)
    const i = { ...row, health: known?.health ?? row.health }
    if (!can(row, "health")) {
      if (can(row, "monitor") && i.lastPollError)
        unchecked.push({
          kind: "failures",
          id: i.id,
          name: i.name,
          detail: `Could not read failures: ${i.lastPollError}`,
          at: i.lastPollAt,
        })
      continue
    }
    if (known?.unknownReason)
      unchecked.push({
        kind: "health",
        id: i.id,
        name: i.name,
        detail: `Health unknown: ${known.unknownReason}`,
        at: i.healthCheckedAt,
      })
    if (i.health === "down" || i.health === "warn") {
      const detail = instanceDetail(i.health, i.healthDetail as Reading)
      items.push({
        kind: "instance",
        tone: i.health === "down" ? "fail" : "warn",
        id: i.id,
        name: i.name,
        health: i.health,
        detail,
        at: i.healthCheckedAt,
      })
    }
    if (i.health === "unknown" && !known?.unknownReason)
      unchecked.push({ kind: "health", id: i.id, name: i.name, detail: "Health unknown", at: null })
    if (can(row, "monitor") && i.lastPollError && i.health !== "down")
      unchecked.push({
        kind: "failures",
        id: i.id,
        name: i.name,
        detail: `Could not read failures: ${i.lastPollError}`,
        at: i.lastPollAt,
      })
  }
  return { ...listed(items), unchecked }
}

async function backupsPart(ctx: Ctx): Promise<Part> {
  const run = {
    status: backupRuns.status,
    error: backupRuns.error,
    startedAt: backupRuns.startedAt,
    finishedAt: backupRuns.finishedAt,
  }
  const last = ctx.db
    .select(run)
    .from(backupRuns)
    .where(eq(backupRuns.instanceId, instances.id))
    .orderBy(desc(backupRuns.startedAt))
    .limit(1)
    .as("last")
  const [all, stale, [self]] = await Promise.all([
    ctx.db
      .select({
        id: instances.id,
        name: instances.name,
        status: last.status,
        error: last.error,
        startedAt: last.startedAt,
        finishedAt: last.finishedAt,
      })
      .from(instances)
      .leftJoinLateral(last, sql`true`)
      .where(activeWith("backup")),
    ctx.db
      .select()
      .from(alertState)
      .where(and(eq(alertState.active, true), like(alertState.key, "backup:%"))),
    ctx.db
      .select(run)
      .from(backupRuns)
      .where(isNull(backupRuns.instanceId))
      .orderBy(desc(backupRuns.startedAt))
      .limit(1),
  ])
  const targets = [
    ...all,
    {
      id: "self",
      name: "n8n-ops database",
      status: self?.status ?? null,
      error: self?.error ?? null,
      startedAt: self?.startedAt ?? null,
      finishedAt: self?.finishedAt ?? null,
    },
  ]
  const byTarget = new Map<string, AttentionItem>()
  for (const t of targets) {
    if (!t.startedAt || (t.status !== "failed" && t.status !== "partial")) continue
    byTarget.set(t.id, {
      kind: "backup",
      tone: t.status === "failed" ? "fail" : "warn",
      id: t.id,
      name: t.name,
      detail:
        t.status === "failed"
          ? `Last backup failed${t.error ? `: ${t.error.slice(0, 500)}` : ""}`
          : "Some copies of the last backup failed",
      running: false,
      at: t.finishedAt ?? t.startedAt,
    })
  }
  for (const s of stale.sort((a, b) => a.since.getTime() - b.since.getTime())) {
    const t = targets.find((x) => x.id === s.key.split(":")[1])
    if (!t || byTarget.has(t.id)) continue
    byTarget.set(t.id, { ...backupItem(t, s), tone: "warn", running: t.status === "running" })
  }
  return listed([...byTarget.values()])
}

async function workersPart(ctx: Ctx): Promise<Part> {
  const offlineSince = new Date(Date.now() - WORKER_ONLINE_MS)
  const items: AttentionItem[] = []
  for (const w of await ctx.db.select().from(workers).where(isNull(workers.revokedAt))) {
    if (w.tokenHash && (!w.lastSeenAt || w.lastSeenAt < offlineSince))
      items.push({ kind: "worker", tone: "warn", id: w.id, name: w.name, at: w.lastSeenAt })
  }
  return listed(items)
}

const readers: Record<AttentionSource, (ctx: Ctx) => Promise<Part>> = {
  access: accessPart,
  problems: problemsPart,
  instances: instancesPart,
  backups: backupsPart,
  workers: workersPart,
}

export async function attention(
  ctx: Ctx,
  { read = readers, timeout = SOURCE_TIMEOUT_MS }: { read?: typeof readers; timeout?: number } = {},
): Promise<Attention> {
  const parts = await Promise.all(
    attentionSources.map(async (source): Promise<[AttentionSource, Part | null]> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${timeout} ms`)), timeout)
      })
      try {
        return [source, await Promise.race([read[source](ctx), late])]
      } catch (error) {
        ctx.log.error("needs attention: a source could not be read", { source, error: (error as Error).message })
        return [source, null]
      } finally {
        clearTimeout(timer)
      }
    }),
  )
  return combine(parts)
}

export function overviewRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))

  app.get("/summary", async (c) => {
    const onlineSince = new Date(Date.now() - WORKER_ONLINE_MS)
    const [open, [total], [online], [pendingAccess]] = await Promise.all([
      openProblemCount(ctx),
      ctx.db.select({ n: count() }).from(workers).where(isNull(workers.revokedAt)),
      ctx.db
        .select({ n: count() })
        .from(workers)
        .where(and(isNull(workers.revokedAt), gt(workers.lastSeenAt, onlineSince))),
      ctx.db
        .select({ n: count() })
        .from(accessRequests)
        .where(and(eq(accessRequests.status, "pending"), gt(accessRequests.decideBy, new Date()))),
    ])
    return c.json({
      openProblems: open,
      pendingAccess: pendingAccess?.n ?? 0,
      workers: { online: online?.n ?? 0, total: total?.n ?? 0 },
      version: ctx.version,
    })
  })

  app.get("/attention", async (c) => c.json(await attention(ctx)))

  app.get("/", async (c) => {
    const rows = await ctx.db.select().from(instances).where(activeOnly)
    const now = await currentHealth(ctx, rows)
    const all = rows.map((r) => ({ health: can(r, "health") ? (now.get(r.id)?.health ?? r.health) : null }))
    const open = await openProblemCount(ctx)
    const [lastBackup] = await ctx.db
      .select({ at: backupRuns.finishedAt })
      .from(backupRuns)
      .where(inArray(backupRuns.status, ["ok", "partial"]))
      .orderBy(desc(backupRuns.finishedAt))
      .limit(1)
    return c.json({
      stats: {
        instances: all.length,
        healthy: all.filter((i) => i.health === "ok").length,
        down: all.filter((i) => i.health === "down").length,
        warn: all.filter((i) => i.health === "warn").length,
        openProblems: open,
        lastBackupAt: lastBackup?.at ?? null,
      },
    })
  })

  return app
}

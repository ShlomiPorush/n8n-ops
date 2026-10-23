import { and, count, desc, eq, gt, inArray, isNull, like, or } from "drizzle-orm"
import { Hono } from "hono"
import type { Ctx } from "../context.ts"
import { accessRequests, alertState, apiTokens, backupRuns, instances, problems, workers } from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import type { Env } from "../http/types.ts"
import { telegramPlainText } from "../services/telegram.ts"

export const WORKER_ONLINE_MS = 90_000
/** The most new problems and regressions the list carries; the total and the tone still count every one. */
export const PROBLEMS_SHOWN = 50

/** How much an item needs a look: red when something fails, amber for a warning, plain (ink) for news (NL-19). */
export type Tone = "fail" | "warn" | "info"

/** What Needs attention reads, each on its own, so one that cannot be read keeps the others (NL-19). */
export const attentionSources = ["access", "problems", "instances", "backups", "workers"] as const
export type AttentionSource = (typeof attentionSources)[number]

/** Something that needs a decision, with what its action needs: the problem, the request, the backup's target. */
export type AttentionItem = { tone: Tone } & (
  | {
      kind: "problem"
      id: string
      status: "open"
      reason: "new" | "regression"
      workflowName: string
      instanceName: string
      errorMessage: string
      count: number
      at: Date
    }
  | { kind: "instance"; id: string; name: string; health: string; detail: string; at: Date | null }
  /** `id` is the instance's, or "self" for the n8n-ops database; `running` while a run is on its way. */
  | { kind: "backup"; id: string; name: string; detail: string; running: boolean; at: Date | null }
  | { kind: "worker"; id: string; name: string; at: Date | null }
  /** `agent` is the token that asks. */
  | { kind: "access"; id: string; name: string; agent: string; detail: string; at: Date | null }
)

/** A check that could not run, so the list must not say that all is well (NL-19, FB-10). */
export type UncheckedItem = {
  /** The instance's health was never read, or reading its failures failed. */
  kind: "health" | "failures"
  id: string
  name: string
  detail: string
  at: Date | null
}

export type Attention = {
  /** Every eligible item, the worst first, then the newest; problems past PROBLEMS_SHOWN are left out. */
  items: AttentionItem[]
  /** Every eligible item, those left out included. */
  total: number
  /** The worst tone over every eligible item, those left out included; null when nothing needs a look. */
  tone: Tone | null
  /** Eligible problems left out of `items`. */
  moreProblems: number
  unchecked: UncheckedItem[]
  /** Sources that could not be read; their items are missing here, and the UI keeps what it showed of them. */
  failed: AttentionSource[]
}

/** What one source found: its items, how many there are in all, and the worst of them. */
type Part = { items: AttentionItem[]; total: number; tone: Tone | null; unchecked?: UncheckedItem[] }

const rank: Record<Tone, number> = { fail: 0, warn: 1, info: 2 }

/** The worst of some tones, or null for none. */
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

/**
 * Puts the sources together: the worst first, then the newest. Total and tone are over every eligible item, also
 * those a source left out of its list; a source that could not be read (null) is named in `failed`.
 */
export function combine(parts: [AttentionSource, Part | null][]): Attention {
  const read = parts.flatMap(([, p]) => (p ? [p] : []))
  const time = (i: { at: Date | null }) => i.at?.getTime() ?? 0
  const items = read.flatMap((p) => p.items).sort((a, b) => rank[a.tone] - rank[b.tone] || time(b) - time(a))
  const total = read.reduce((sum, p) => sum + p.total, 0)
  return {
    items,
    total,
    tone: worstTone(read.map((p) => p.tone)),
    moreProblems: total - items.length,
    unchecked: read.flatMap((p) => p.unchecked ?? []),
    failed: parts.flatMap(([source, p]) => (p ? [] : [source])),
  }
}

/** A backup alert that is still active, with the alert's text as written (names and errors not escaped). */
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

/** Agents waiting for access: amber, each with the request Approve needs. */
async function accessPart(ctx: Ctx): Promise<Part> {
  const waiting = await ctx.db
    .select({ r: accessRequests, instanceName: instances.name, tokenName: apiTokens.name })
    .from(accessRequests)
    .innerJoin(instances, eq(accessRequests.instanceId, instances.id))
    .innerJoin(apiTokens, eq(accessRequests.tokenId, apiTokens.id))
    .where(and(eq(accessRequests.status, "pending"), gt(accessRequests.decideBy, new Date())))
    .orderBy(desc(accessRequests.requestedAt))
  return listed(
    waiting.map(({ r, instanceName, tokenName }) => ({
      kind: "access",
      tone: "warn",
      id: r.id,
      name: instanceName,
      agent: tokenName,
      detail: `${tokenName} asks for access: ${r.reason}`,
      at: r.requestedAt,
    })),
  )
}

/**
 * New problems and regressions seen in the last 24 hours: red. Which problems count is decided in the query,
 * before the limit, so problems that do not count can never push one that does out of the list; the total
 * counts every one.
 */
async function problemsPart(ctx: Ctx): Promise<Part> {
  const dayAgo = new Date(Date.now() - 86_400_000)
  const eligible = and(
    eq(problems.status, "open"),
    isNull(problems.mergedInto),
    gt(problems.lastSeen, dayAgo),
    or(eq(problems.regression, true), gt(problems.firstSeen, dayAgo)),
  )
  const [shown, [all]] = await Promise.all([
    ctx.db
      .select({ p: problems, instanceName: instances.name })
      .from(problems)
      .innerJoin(instances, eq(problems.instanceId, instances.id))
      .where(eligible)
      .orderBy(desc(problems.lastSeen), desc(problems.id))
      .limit(PROBLEMS_SHOWN),
    ctx.db.select({ n: count() }).from(problems).where(eligible),
  ])
  const total = all?.n ?? 0
  return {
    items: shown.map(({ p, instanceName }) => ({
      kind: "problem",
      tone: "fail",
      id: p.id,
      status: "open",
      reason: p.regression ? "regression" : "new",
      workflowName: p.workflowName,
      instanceName,
      errorMessage: p.errorMessage,
      count: p.count,
      at: p.lastSeen,
    })),
    total,
    tone: total ? "fail" : null,
  }
}

/**
 * Unhealthy instances (down red, warn amber), and the checks that could not run: health never read, or reading
 * the failures failed. A down instance already says it cannot be reached, so its failed read is not listed too.
 */
async function instancesPart(ctx: Ctx): Promise<Part> {
  const all = await ctx.db.select().from(instances)
  const items: AttentionItem[] = []
  const unchecked: UncheckedItem[] = []
  for (const i of all) {
    if (i.health === "down" || i.health === "warn") {
      const d = i.healthDetail as {
        main?: { error?: string }
        backlogActive?: boolean
        workers?: { ok: boolean }[]
      } | null
      const detail =
        i.health === "down"
          ? `Not responding${d?.main?.error ? `: ${d.main.error}` : ""}`
          : d?.backlogActive
            ? "Queue backlog"
            : d?.workers?.some((w) => !w.ok)
              ? "A queue worker is down"
              : "Not ready"
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
    if (i.health === "unknown")
      unchecked.push({ kind: "health", id: i.id, name: i.name, detail: "Health not checked yet", at: null })
    if (i.lastPollError && i.health !== "down")
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

/**
 * Backups that need a look, one item per instance or n8n-ops itself: the last run failed (red), some of its
 * copies failed or no backup succeeded in time (amber). The latest run also says whether one is running now.
 */
async function backupsPart(ctx: Ctx): Promise<Part> {
  const [all, stale, latest] = await Promise.all([
    ctx.db.select({ id: instances.id, name: instances.name }).from(instances),
    ctx.db
      .select()
      .from(alertState)
      .where(and(eq(alertState.active, true), like(alertState.key, "backup:%"))),
    ctx.db
      .selectDistinctOn([backupRuns.instanceId], {
        instanceId: backupRuns.instanceId,
        status: backupRuns.status,
        error: backupRuns.error,
        startedAt: backupRuns.startedAt,
        finishedAt: backupRuns.finishedAt,
      })
      .from(backupRuns)
      .orderBy(backupRuns.instanceId, desc(backupRuns.startedAt)),
  ])
  const target = (id: string) =>
    id === "self" ? { id: "self", name: "n8n-ops database" } : all.find((i) => i.id === id)
  const running = new Set(latest.filter((r) => r.status === "running").map((r) => r.instanceId ?? "self"))
  const byTarget = new Map<string, AttentionItem>()
  for (const r of latest) {
    const t = target(r.instanceId ?? "self")
    if (!t || (r.status !== "failed" && r.status !== "partial")) continue
    byTarget.set(t.id, {
      kind: "backup",
      tone: r.status === "failed" ? "fail" : "warn",
      id: t.id,
      name: t.name,
      detail:
        r.status === "failed"
          ? `Last backup failed${r.error ? `: ${r.error.slice(0, 500)}` : ""}`
          : "Some copies of the last backup failed",
      running: running.has(t.id),
      at: r.finishedAt ?? r.startedAt,
    })
  }
  // Keys are backup:<instance id or self>:<destination id>; the oldest alert of a target speaks for it.
  for (const s of stale.sort((a, b) => a.since.getTime() - b.since.getTime())) {
    const t = target(s.key.split(":")[1] ?? "")
    if (!t || byTarget.has(t.id)) continue
    byTarget.set(t.id, { ...backupItem(t, s), tone: "warn", running: running.has(t.id) })
  }
  return listed([...byTarget.values()])
}

/** Paired workers that stopped reporting: amber. */
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

/**
 * What needs the operator now (NL-19, FB-10): agents waiting for access, new problems and regressions from the
 * last 24 hours, unhealthy instances, backups that failed or are late, offline workers. Each source is read on its
 * own: one that fails is named in `failed` and the others still answer.
 */
export async function attention(ctx: Ctx): Promise<Attention> {
  const parts = await Promise.all(
    attentionSources.map(async (source): Promise<[AttentionSource, Part | null]> => {
      try {
        return [source, await readers[source](ctx)]
      } catch (error) {
        ctx.log.error("needs attention: a source could not be read", { source, error: (error as Error).message })
        return [source, null]
      }
    }),
  )
  return combine(parts)
}

export function overviewRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))

  // Small summary for the sidebar.
  app.get("/summary", async (c) => {
    const onlineSince = new Date(Date.now() - WORKER_ONLINE_MS)
    const [[open], [total], [online], [pendingAccess]] = await Promise.all([
      ctx.db
        .select({ n: count() })
        .from(problems)
        .where(and(eq(problems.status, "open"), isNull(problems.mergedInto))),
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
      openProblems: open?.n ?? 0,
      pendingAccess: pendingAccess?.n ?? 0,
      workers: { online: online?.n ?? 0, total: total?.n ?? 0 },
    })
  })

  // Needs attention, read by the bell on every page and by Overview (NL-19).
  app.get("/attention", async (c) => c.json(await attention(ctx)))

  app.get("/", async (c) => {
    const all = await ctx.db.select().from(instances)
    const [open] = await ctx.db
      .select({ n: count() })
      .from(problems)
      .where(and(eq(problems.status, "open"), isNull(problems.mergedInto)))
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
        openProblems: open?.n ?? 0,
        lastBackupAt: lastBackup?.at ?? null,
      },
    })
  })

  return app
}

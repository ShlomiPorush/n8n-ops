import { and, count, desc, eq, gt, isNull } from "drizzle-orm"
import { Hono } from "hono"
import type { Ctx } from "../context.ts"
import { accessRequests, alertState, apiTokens, backupRuns, instances, problems, workers } from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import type { Env } from "../http/types.ts"
import { telegramPlainText } from "../services/telegram.ts"

export const WORKER_ONLINE_MS = 90_000

export type AttentionItem =
  | {
      kind: "problem"
      id: string
      reason: "new" | "regression"
      workflowName: string
      instanceName: string
      errorMessage: string
      count: number
      at: Date
    }
  | { kind: "instance"; id: string; name: string; health: string; detail: string; at: Date | null }
  | { kind: "backup"; id: string; name: string; detail: string; at: Date | null }
  | { kind: "worker"; id: string; name: string; at: Date | null }
  | { kind: "access"; id: string; name: string; detail: string; at: Date | null }

/** A backup alert that is still active, with the alert's text as written (names and errors not escaped). */
export function backupItem(
  instance: Pick<typeof instances.$inferSelect, "id" | "name">,
  state: Pick<typeof alertState.$inferSelect, "detail" | "since">,
): AttentionItem {
  return {
    kind: "backup",
    id: instance.id,
    name: instance.name,
    detail: telegramPlainText(state.detail ?? ""),
    at: state.since,
  }
}

/**
 * What needs the operator now: agents waiting for access, recent new problems and regressions, unhealthy
 * instances, stale backups, offline workers.
 */
export async function attention(ctx: Ctx): Promise<AttentionItem[]> {
  const waiting = await ctx.db
    .select({ r: accessRequests, instanceName: instances.name, tokenName: apiTokens.name })
    .from(accessRequests)
    .innerJoin(instances, eq(accessRequests.instanceId, instances.id))
    .innerJoin(apiTokens, eq(accessRequests.tokenId, apiTokens.id))
    .where(and(eq(accessRequests.status, "pending"), gt(accessRequests.decideBy, new Date())))
    .orderBy(desc(accessRequests.requestedAt))
  const dayAgo = new Date(Date.now() - 86_400_000)
  const recent = await ctx.db
    .select({ p: problems, instanceName: instances.name })
    .from(problems)
    .innerJoin(instances, eq(problems.instanceId, instances.id))
    .where(and(eq(problems.status, "open"), isNull(problems.mergedInto), gt(problems.lastSeen, dayAgo)))
    .orderBy(desc(problems.lastSeen))
    .limit(50)
  const items: AttentionItem[] = waiting.map(({ r, instanceName, tokenName }) => ({
    kind: "access",
    id: r.id,
    name: instanceName,
    detail: `${tokenName} asks for access: ${r.reason}`,
    at: r.requestedAt,
  }))
  items.push(
    ...recent
      .filter(({ p }) => p.regression || p.firstSeen > dayAgo)
      .map(
        ({ p, instanceName }): AttentionItem => ({
          kind: "problem",
          id: p.id,
          reason: p.regression ? "regression" : "new",
          workflowName: p.workflowName,
          instanceName,
          errorMessage: p.errorMessage,
          count: p.count,
          at: p.lastSeen,
        }),
      ),
  )
  const all = await ctx.db.select().from(instances)
  for (const i of all.filter((x) => x.health === "down" || x.health === "warn")) {
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
    items.push({ kind: "instance", id: i.id, name: i.name, health: i.health, detail, at: i.healthCheckedAt })
  }
  const stale = await ctx.db.select().from(alertState).where(eq(alertState.active, true))
  for (const s of stale.filter((x) => x.key.startsWith("backup:"))) {
    const instance = all.find((i) => s.key === `backup:${i.id}`)
    if (instance) items.push(backupItem(instance, s))
  }
  const offlineSince = new Date(Date.now() - WORKER_ONLINE_MS)
  for (const w of await ctx.db.select().from(workers).where(isNull(workers.revokedAt))) {
    if (w.tokenHash && (!w.lastSeenAt || w.lastSeenAt < offlineSince))
      items.push({ kind: "worker", id: w.id, name: w.name, at: w.lastSeenAt })
  }
  return items
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

  app.get("/", async (c) => {
    const items = await attention(ctx)
    const all = await ctx.db.select().from(instances)
    const [open] = await ctx.db
      .select({ n: count() })
      .from(problems)
      .where(and(eq(problems.status, "open"), isNull(problems.mergedInto)))
    const [lastBackup] = await ctx.db
      .select({ at: backupRuns.finishedAt })
      .from(backupRuns)
      .where(eq(backupRuns.status, "ok"))
      .orderBy(desc(backupRuns.finishedAt))
      .limit(1)
    return c.json({
      attention: items,
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

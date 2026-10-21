import { and, asc, desc, eq, ilike, isNotNull, or, type SQL, sql } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { backupRuns, failures, instances, workflows } from "../db/schema.ts"
import { likeContains } from "../lib/like.ts"
import { listProblems, problemDetail } from "../routes/problems.ts"
import { grantableScopes } from "./access.ts"
import { effectiveScopes, executionUrl, latestN8nVersion } from "./instances.ts"

/**
 * Read-only queries for agents (requirements E1 to E3). The REST API and the MCP server both use these,
 * so they always return the same picture.
 */

export async function agentProblems(
  ctx: Ctx,
  opts: { status?: string; instance?: string; q?: string; limit?: number },
) {
  let instanceId: string | undefined
  if (opts.instance) {
    const [row] = await ctx.db.select({ id: instances.id }).from(instances).where(eq(instances.name, opts.instance))
    instanceId = row?.id ?? "00000000-0000-0000-0000-000000000000"
  }
  return listProblems(ctx, {
    status: opts.status ?? "open",
    instanceId,
    q: opts.q,
    limit: Math.min(opts.limit ?? 50, 200),
  })
}

export async function agentProblem(ctx: Ctx, id: string) {
  return problemDetail(ctx, id)
}

/** The stored failed execution: error, stack, node input and n8n's full run data. */
export async function agentFailure(ctx: Ctx, problemId: string, failureId?: string) {
  const where = failureId
    ? and(eq(failures.problemId, problemId), eq(failures.id, failureId))
    : eq(failures.problemId, problemId)
  const [row] = await ctx.db
    .select({ f: failures, baseUrl: instances.baseUrl, instanceName: instances.name })
    .from(failures)
    .innerJoin(instances, eq(failures.instanceId, instances.id))
    .where(where)
    .orderBy(desc(failures.createdAt))
    .limit(1)
  if (!row) return null
  return {
    ...row.f,
    instanceName: row.instanceName,
    n8nUrl: executionUrl({ baseUrl: row.baseUrl }, row.f.workflowId, row.f.executionId),
  }
}

export async function agentInstances(ctx: Ctx) {
  const latest = await latestN8nVersion()
  const rows = await ctx.db.select().from(instances).orderBy(asc(instances.name))
  return rows.map((i) => ({
    id: i.id,
    name: i.name,
    baseUrl: i.baseUrl,
    version: i.version,
    latestVersion: latest,
    health: i.health,
    healthDetail: i.healthDetail,
    healthCheckedAt: i.healthCheckedAt,
    queueMode: i.queueMode,
    lastPollAt: i.lastPollAt,
    lastPollError: i.lastPollError,
    scopes: effectiveScopes(i),
  }))
}

export async function agentQueues(ctx: Ctx) {
  const rows = await ctx.db.select().from(instances).where(eq(instances.queueMode, true))
  return rows.map((i) => {
    const d = i.healthDetail as { queue?: unknown; workers?: unknown; backlogActive?: boolean } | null
    return {
      name: i.name,
      health: i.health,
      queue: d?.queue ?? null,
      workers: d?.workers ?? [],
      backlogActive: Boolean(d?.backlogActive),
      checkedAt: i.healthCheckedAt,
    }
  })
}

export async function agentBackups(ctx: Ctx) {
  const rows = await ctx.db.select().from(instances).orderBy(asc(instances.name))
  return Promise.all(
    rows.map(async (i) => {
      const [last] = await ctx.db
        .select()
        .from(backupRuns)
        .where(eq(backupRuns.instanceId, i.id))
        .orderBy(desc(backupRuns.startedAt))
        .limit(1)
      const [lastOk] = await ctx.db
        .select()
        .from(backupRuns)
        .where(and(eq(backupRuns.instanceId, i.id), eq(backupRuns.status, "ok"), isNotNull(backupRuns.finishedAt)))
        .orderBy(desc(backupRuns.startedAt))
        .limit(1)
      return {
        instance: i.name,
        lastRun: last ? { status: last.status, startedAt: last.startedAt, error: last.error } : null,
        lastSuccess: lastOk
          ? { at: lastOk.startedAt, includesSecrets: lastOk.includesSecrets, sizeBytes: lastOk.sizeBytes }
          : null,
      }
    }),
  )
}

export async function agentWorkflows(ctx: Ctx, opts: { q?: string; instance?: string; limit?: number }) {
  const where: SQL[] = []
  if (opts.q) {
    // Agents often hold an ID, a webhook URL or a tag rather than the exact name.
    const like = likeContains(opts.q)
    const path = opts.q.replace(/^https?:\/\/[^/]+/, "").replace(/^\/webhook(-test)?\//, "")
    const match = or(
      ilike(workflows.name, like),
      eq(workflows.workflowId, opts.q),
      path.length >= 3 ? ilike(workflows.triggerDetail, likeContains(path)) : undefined,
      // Each tag on its own: the JSON text of the list doubles backslashes and has quotes and commas of its own.
      sql`exists (select 1 from jsonb_array_elements_text(${workflows.tags}) as t(tag) where t.tag ilike ${like})`,
    )
    if (match) where.push(match)
  }
  if (opts.instance) where.push(eq(instances.name, opts.instance))
  const rows = await ctx.db
    .select({ w: workflows, instanceName: instances.name })
    .from(workflows)
    .innerJoin(instances, eq(workflows.instanceId, instances.id))
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(workflows.name))
    .limit(Math.min(opts.limit ?? 100, 500))
  const policies = new Map(
    (await ctx.db.select().from(instances)).map((i) => {
      const scopes = grantableScopes(i)
      return [i.name, { requestable: scopes.length > 0, grantableScopes: scopes }]
    }),
  )
  return rows.map(({ w, instanceName }) => ({
    instance: instanceName,
    workflowId: w.workflowId,
    name: w.name,
    active: w.active,
    tags: w.tags,
    access: policies.get(instanceName) ?? { requestable: false, grantableScopes: [] },
    trigger: w.triggerDetail ? `${w.triggerType} ${w.triggerDetail}` : w.triggerType,
    lastRunAt: w.lastRunAt,
    runs30d: w.runs30d,
    errors30d: w.errors30d,
  }))
}

import { and, asc, desc, eq, ilike, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { backupRuns, type Health, instances, workflows } from "../db/schema.ts"
import { likeContains } from "../lib/like.ts"
import { grantableScopes } from "./access.ts"
import { currentHealth, type HealthNow } from "./collection.ts"
import { effectiveScopes, latestN8nVersion } from "./instances.ts"
import { problemDetail, problemFailure, problemPage } from "./problem-view.ts"

/**
 * Read-only queries for agents (requirements E1 to E3). The REST API and the MCP server both use these,
 * so they always return the same picture.
 */

/**
 * Problems for agents: one per exact error, with the workflows it hit (`affectedWorkflows`, most recently failed
 * first, at most AFFECTED_IN_LIST; `affectedTotal` counts them all). With an instance, a Problem is listed when it hit
 * that instance, its state is its state there, and that instance's workflows come first.
 */
export async function agentProblems(
  ctx: Ctx,
  opts: { status?: string; instance?: string; q?: string; limit?: number },
) {
  let instanceId: string | undefined
  if (opts.instance) {
    const [row] = await ctx.db.select({ id: instances.id }).from(instances).where(eq(instances.name, opts.instance))
    if (!row) return []
    instanceId = row.id
  }
  const { items } = await problemPage(ctx, {
    status: opts.status ?? "open",
    instanceId,
    q: opts.q,
    limit: Math.min(opts.limit ?? 50, 200),
    // Most recently seen first, as it always was.
    order: "recent",
  })
  return items
}

/**
 * One Problem with all its workflows, and the chosen one's latest failure (`selected`). The id may be an Affected
 * workflow's (it is then the one chosen) or a merged Problem's; `affectedWorkflowId` chooses explicitly.
 */
export async function agentProblem(ctx: Ctx, id: string, affectedWorkflowId?: string) {
  return problemDetail(ctx, id, affectedWorkflowId)
}

/**
 * A stored failed execution: error, stack, node input and n8n's full run data. The latest of the workflow an
 * Affected workflow id or `affectedWorkflowId` names, else of the whole Problem; a `failureId` must belong to both.
 */
export async function agentFailure(ctx: Ctx, problemId: string, failureId?: string, affectedWorkflowId?: string) {
  return problemFailure(ctx, problemId, { failure: failureId, workflow: affectedWorkflowId })
}

const healthFields = (i: { id: string; health: Health }, now: Map<string, HealthNow>) => {
  const h = now.get(i.id)
  return {
    health: h?.health ?? i.health,
    lastKnownHealth: h?.lastKnownHealth ?? null,
    lastKnownAt: h?.lastKnownAt ?? null,
    unknownReason: h?.unknownReason ?? null,
  }
}

export async function agentInstances(ctx: Ctx) {
  const latest = await latestN8nVersion()
  const rows = await ctx.db.select().from(instances).orderBy(asc(instances.name))
  const now = await currentHealth(ctx, rows)
  return rows.map((i) => ({
    id: i.id,
    name: i.name,
    baseUrl: i.baseUrl,
    version: i.version,
    latestVersion: latest,
    // "unknown" when nothing collects it now; healthDetail and healthCheckedAt are then the last check, and
    // lastKnownHealth and lastKnownAt the last check that read the instance.
    ...healthFields(i, now),
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
  const now = await currentHealth(ctx, rows)
  return rows.map((i) => {
    const d = i.healthDetail as { queue?: unknown; workers?: unknown; backlogActive?: boolean } | null
    return {
      name: i.name,
      // "unknown" when nothing collects it now; the queue figures and checkedAt are then those of the last check.
      ...healthFields(i, now),
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
        .where(
          and(
            eq(backupRuns.instanceId, i.id),
            inArray(backupRuns.status, ["ok", "partial"]),
            isNotNull(backupRuns.finishedAt),
          ),
        )
        .orderBy(desc(backupRuns.startedAt))
        .limit(1)
      return {
        instance: i.name,
        // partial: some destinations have the archive, others failed (see error).
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

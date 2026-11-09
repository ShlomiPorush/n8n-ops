import { and, asc, count, desc, eq, ilike, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { backupRuns, type Health, instances, workflows } from "../db/schema.ts"
import { likeContains } from "../lib/like.ts"
import { grantableScopes } from "./access.ts"
import { currentHealth, type HealthNow } from "./collection.ts"
import { checkFacts } from "./health-history.ts"
import { activeOnly, effectiveScopes, latestN8nVersion } from "./instances.ts"
import { problemDetail, problemFailure, problemPage, regroupedView } from "./problem-view.ts"

/**
 * Read-only queries for agents (requirements E1 to E3). The REST API and the MCP server both use these,
 * so they always return the same picture.
 */

/**
 * Problems for agents: one per cause (docs/adr/0003), with the workflows it hit (`affectedWorkflows`, most recently failed
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
  // An id the regroup by cause replaced answers where its workflows went (docs/adr/0003).
  return (await regroupedView(ctx, id)) ?? problemDetail(ctx, id, affectedWorkflowId)
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
  const latest = await latestN8nVersion(ctx)
  const rows = await ctx.db.select().from(instances).where(activeOnly).orderBy(asc(instances.name))
  const now = await currentHealth(ctx, rows)
  const settings = await Promise.all(rows.map((i) => ctx.settings.forInstance(i.overrides)))
  return rows.map((i, n) => ({
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
    // How the instance is checked now and when a down alert is sent; past checks are in the health history.
    check: settings[n] ? checkFacts(i, settings[n]) : null,
    queueMode: i.queueMode,
    // The main as a Compose project and service, when it is named so (both null otherwise).
    composeProject: i.composeProject,
    composeService: i.composeService,
    lastPollAt: i.lastPollAt,
    lastPollError: i.lastPollError,
    scopes: effectiveScopes(i),
  }))
}

export async function agentQueues(ctx: Ctx) {
  const rows = await ctx.db
    .select()
    .from(instances)
    .where(and(eq(instances.queueMode, true), activeOnly))
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
  const rows = await ctx.db.select().from(instances).where(activeOnly).orderBy(asc(instances.name))
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

/** The most workflows one call returns, and how many when the caller does not say. */
export const WORKFLOWS_MAX = 500
export const WORKFLOWS_DEFAULT = 100

/**
 * One page of the workflows that match, by name, then instance, then ID, so the pages never overlap; `total` counts
 * every match and `nextOffset` is where the next page starts (null after the last). The page and the count are read
 * from one snapshot, so they always agree; a sync between two calls can still move workflows across pages.
 */
export async function agentWorkflows(
  ctx: Ctx,
  opts: { q?: string; instance?: string; limit?: number; offset?: number },
) {
  const limit = Math.min(opts.limit ?? WORKFLOWS_DEFAULT, WORKFLOWS_MAX)
  const offset = opts.offset ?? 0
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
  const filter = where.length ? and(...where) : undefined
  const { rows, total, all } = await ctx.db.transaction(
    async (tx) => {
      const rows = await tx
        .select({ w: workflows, instanceName: instances.name })
        .from(workflows)
        .innerJoin(instances, eq(workflows.instanceId, instances.id))
        .where(filter)
        .orderBy(asc(workflows.name), asc(instances.name), asc(workflows.workflowId))
        .limit(limit)
        .offset(offset)
      const [counted] = await tx
        .select({ total: count() })
        .from(workflows)
        .innerJoin(instances, eq(workflows.instanceId, instances.id))
        .where(filter)
      return { rows, total: counted?.total ?? 0, all: await tx.select().from(instances) }
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  )
  const policies = new Map(
    all.map((i) => {
      const scopes = grantableScopes(i)
      return [i.name, { requestable: scopes.length > 0, grantableScopes: scopes }]
    }),
  )
  const next = offset + rows.length
  const page = rows.map(({ w, instanceName }) => ({
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
  return { workflows: page, total, nextOffset: next < total ? next : null }
}

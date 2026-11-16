import { unsupportedVersionText } from "@n8n-ops/shared"
import { and, eq, notInArray } from "drizzle-orm"
import { type Ctx, changed } from "../context.ts"
import { instances, workflows } from "../db/schema.ts"
import { sha256 } from "../lib/crypto.ts"
import { oneAtATime } from "../lib/one-at-a-time.ts"
import { makeStorable, storableText } from "../lib/storable.ts"
import { N8nError, type N8nExecution, type N8nWorkflow } from "../n8n/client.ts"
import { describeTrigger } from "../n8n/execution.ts"
import { can, clientFor, type Instance, unsupportedVersion } from "./instances.ts"

/**
 * Same structure = same node types connected the same way. Node names, positions and parameters are
 * ignored, so a renamed copy still matches (requirement F2).
 */
export function structureHash(workflow: Pick<N8nWorkflow, "nodes" | "connections">): string {
  const nodes = workflow.nodes.filter((n) => !n.type.endsWith(".stickyNote"))
  const typeOf = new Map(nodes.map((n) => [n.name, n.type]))
  const types = nodes.map((n) => n.type).sort()
  const edges: string[] = []
  for (const [from, outputs] of Object.entries(workflow.connections ?? {}))
    outputs.main?.forEach((targets, i) => {
      for (const t of targets ?? []) edges.push(`${typeOf.get(from)}#${i}>${typeOf.get(t.node)}`)
    })
  return sha256(JSON.stringify({ types, edges: edges.sort() }))
}

/**
 * An identifier n8n-ops keeps exactly as n8n gave it: a non-empty string PostgreSQL can store unchanged. An
 * identifier is never cleaned, since a cleaned one could name another workflow or credential.
 */
const storableId = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && storableText(value) === value

/** The credentials the workflow's nodes use, by ID; an entry without a storable ID is left out. */
export function credentialIds(workflow: Pick<N8nWorkflow, "nodes">): string[] {
  const ids = workflow.nodes.flatMap((n) =>
    Object.values(n.credentials ?? {}).map((c) => (c as { id?: unknown } | null)?.id),
  )
  return [...new Set(ids)].filter(storableId)
}

/** Ids of workflows called with Execute Workflow nodes (by id, which breaks when moved). */
export function calledWorkflowIds(workflow: Pick<N8nWorkflow, "nodes">): string[] {
  const ids = workflow.nodes
    .filter((n) => /executeWorkflow$/i.test(n.type) && !n.disabled)
    .map((n) => {
      const ref = n.parameters?.workflowId as string | { value?: string } | undefined
      return typeof ref === "string" ? ref : (ref?.value ?? "")
    })
  return [...new Set(ids.map((id) => String(id).replace(/^=/, "")))].filter(
    (id) => storableId(id) && !id.includes("{{"),
  )
}

type ExecutionPage = { data: Pick<N8nExecution, "workflowId" | "status" | "startedAt">[]; nextCursor: string | null }
type ExecutionLister = {
  listExecutions(
    query: { limit?: number; cursor?: string; startedAfter?: string },
    signal?: AbortSignal,
  ): Promise<ExecutionPage>
}

/** Older n8n (2.30 among them) has no `startedAfter` filter on GET /executions and answers 400 to it. */
const rejectsStartedAfter = (error: unknown) =>
  error instanceof N8nError && error.status === 400 && /startedAfter/.test(error.body ?? "")

/**
 * Every execution started at or after `since` that the instance still keeps, newest first, read 250 at a time to
 * the end. When the instance does not know the `startedAfter` filter, it reads all executions and keeps those that
 * started in the window: n8n orders by ID, not by start, and a run that waited in the queue starts after newer ones,
 * so an older page can still hold one. A run that never started (cancelled while queued) is not counted, as with the
 * filter. It stops if n8n hands back a cursor it already gave, and throws once `signal` aborts.
 */
export async function executionsSince(client: ExecutionLister, since: string, signal?: AbortSignal) {
  const sinceMs = Date.parse(since)
  const out: ExecutionPage["data"] = []
  const seen = new Set<string>()
  let filtered = true
  let cursor: string | undefined
  for (;;) {
    signal?.throwIfAborted()
    let res: ExecutionPage
    try {
      res = await client.listExecutions({ limit: 250, cursor, ...(filtered ? { startedAfter: since } : {}) }, signal)
    } catch (error) {
      if (!filtered || cursor || !rejectsStartedAfter(error)) throw error
      filtered = false
      res = await client.listExecutions({ limit: 250 }, signal)
    }
    for (const { workflowId, status, startedAt } of res.data)
      if (filtered || (startedAt && Date.parse(startedAt) >= sinceMs)) out.push({ workflowId, status, startedAt })
    if (!res.nextCursor || seen.has(res.nextCursor)) break
    seen.add(res.nextCursor)
    cursor = res.nextCursor
  }
  return out
}

/** At most this many instances sync at once: each sync lists every workflow and pages through 30 days of runs. */
const SYNCS_AT_ONCE = 2

/** The longest a sync may spend reading an instance's workflows and runs from n8n, so it always gives its slot back. */
const READ_DEADLINE_MS = 30 * 60_000
let syncing = 0
const slotWaiters: (() => void)[] = []

async function inSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (syncing < SYNCS_AT_ONCE) syncing += 1
  else await new Promise<void>((take) => slotWaiters.push(take))
  try {
    return await fn()
  } finally {
    // The slot passes straight to the next waiter, so the count stays.
    const next = slotWaiters.shift()
    if (next) next()
    else syncing -= 1
  }
}

/** Instances with a sync waiting to start, and with one running. */
const waiting = new Map<string, Promise<{ workflows: number }>>()
const running = new Set<string>()

/** When each instance's last sync started reading, whoever asked for it. */
const startedAt = new Map<string, number>()

/** Whether a sync of the instance is running or waiting, so the scheduler does not ask for another. */
export const workflowSyncBusy = (instanceId: string) => waiting.has(instanceId) || running.has(instanceId)

/** When the instance's last sync started reading, in milliseconds; 0 when none has since the server started. */
export const lastWorkflowSync = (instanceId: string) => startedAt.get(instanceId) ?? 0

/**
 * Reads every workflow of an instance and its run counts for the last 30 days (requirement F1). One at a time per
 * instance: an earlier sync that read an older list would otherwise delete what a later one stored. A call while
 * one waits joins it, so a burst of requests costs one running sync and one after it. The instance is read again
 * when its sync starts, so a sync that waited follows a change made meanwhile (removed, map no longer chosen, a new
 * key or address). Reading from n8n stops after `readDeadlineMs`; the sync then fails before it writes anything.
 */
export function syncWorkflows(
  ctx: Ctx,
  instance: Pick<Instance, "id">,
  { readDeadlineMs = READ_DEADLINE_MS }: { readDeadlineMs?: number } = {},
): Promise<{ workflows: number }> {
  const queued = waiting.get(instance.id)
  if (queued) return queued
  const run = oneAtATime(`workflows:${instance.id}`, async () => {
    waiting.delete(instance.id)
    running.add(instance.id)
    try {
      return await inSlot(async () => {
        startedAt.set(instance.id, Date.now())
        const [fresh] = await ctx.db.select().from(instances).where(eq(instances.id, instance.id))
        if (!fresh) throw new Error("The instance was removed.")
        if (!can(fresh, "map")) throw new Error(`The workflow map is not chosen for ${fresh.name}.`)
        if (unsupportedVersion(fresh)) throw new Error(unsupportedVersionText)
        return syncWorkflowsNow(ctx, fresh, readDeadlineMs)
      })
    } finally {
      running.delete(instance.id)
    }
  })
  waiting.set(instance.id, run)
  return run
}

async function syncWorkflowsNow(ctx: Ctx, instance: Instance, readDeadlineMs: number) {
  const client = clientFor(ctx, instance)
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const deadline = AbortSignal.timeout(readDeadlineMs)
  let all: N8nWorkflow[]
  let runs: Awaited<ReturnType<typeof executionsSince>>
  try {
    all = await client.listWorkflows(undefined, deadline)
    runs = await executionsSince(client, since, deadline)
    deadline.throwIfAborted()
  } catch (error) {
    if (!deadline.aborted) throw error
    const minutes = Math.round(readDeadlineMs / 60_000)
    throw new Error(
      `The workflow sync of ${instance.name} stopped: reading it from n8n took longer than ${minutes} minutes. Its workflow map keeps the last complete sync.`,
    )
  }
  const stats = new Map<string, { runs: number; errors: number; last: Date | null }>()
  for (const e of runs) {
    const s = stats.get(e.workflowId) ?? { runs: 0, errors: 0, last: null }
    s.runs++
    if (e.status === "error" || e.status === "crashed") s.errors++
    const at = e.startedAt ? new Date(e.startedAt) : null
    if (at && (!s.last || at > s.last)) s.last = at
    stats.set(e.workflowId, s)
  }
  // A workflow n8n gives in a form the map cannot read is skipped, and the rest of the map still syncs. One with a
  // storable ID keeps the row an earlier sync stored until n8n no longer lists it; one without cannot have a row.
  const listed: string[] = []
  const skipped: string[] = []
  let skippedWithoutId = 0
  for (const w of all) {
    const id: unknown = w?.id
    if (!storableId(id)) {
      skippedWithoutId += 1
      continue
    }
    listed.push(id)
    let row: ReturnType<typeof workflowRow>
    try {
      row = workflowRow(w, stats.get(id))
    } catch {
      skipped.push(id)
      continue
    }
    await ctx.db
      .insert(workflows)
      .values({ instanceId: instance.id, workflowId: id, ...row })
      .onConflictDoUpdate({ target: [workflows.instanceId, workflows.workflowId], set: row })
  }
  if (skipped.length || skippedWithoutId)
    ctx.log.warn("workflow map sync skipped workflows it could not read", {
      instance: instance.name,
      skipped: skipped.length + skippedWithoutId,
      ids: skipped.slice(0, 10),
    })
  await ctx.db
    .delete(workflows)
    .where(
      and(eq(workflows.instanceId, instance.id), listed.length ? notInArray(workflows.workflowId, listed) : undefined),
    )
  changed(ctx, "workflows", "instances")
  return { workflows: all.length }
}

/**
 * The map's row for one workflow. Throws when n8n gave the workflow in a form it cannot read. Its text is made
 * storable (lib/storable.ts); its IDs are kept only as n8n gave them.
 */
function workflowRow(w: N8nWorkflow, s: { runs: number; errors: number; last: Date | null } | undefined) {
  if (typeof w.name !== "string" || !Array.isArray(w.nodes)) throw new Error("unexpected workflow form")
  const trigger = describeTrigger(w)
  const row = {
    name: w.name,
    active: w.active === true,
    archived: w.isArchived === true,
    triggerType: trigger.type,
    triggerDetail: trigger.detail,
    structureHash: structureHash(w),
    nodeCount: w.nodes.length,
    credentialIds: credentialIds(w),
    calledWorkflowIds: calledWorkflowIds(w),
    tags: (w.tags ?? []).map((t) => (t as { name?: unknown } | null)?.name).filter((t) => typeof t === "string"),
    lastRunAt: s?.last ?? null,
    runs30d: s?.runs ?? 0,
    errors30d: s?.errors ?? 0,
    syncedAt: new Date(),
  }
  makeStorable(row)
  return row
}

/**
 * Syncs the workflows of an instance now, without waiting for it: after activation, so the counts appear at once
 * instead of at the next run of the workflow-map job. Only where the map is chosen and the n8n version is read
 * through its API. A busy instance pages through 30 days of executions, so the caller does not await it.
 */
export function syncWorkflowsSoon(ctx: Ctx, instance: Instance) {
  if (!can(instance, "map") || unsupportedVersion(instance)) return
  void syncWorkflows(ctx, instance).catch((e: Error) =>
    ctx.log.warn("workflow sync failed", { instance: instance.name, error: e.message }),
  )
}

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

const storableId = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && storableText(value) === value

export function credentialIds(workflow: Pick<N8nWorkflow, "nodes">): string[] {
  const ids = workflow.nodes.flatMap((n) =>
    Object.values(n.credentials ?? {}).map((c) => (c as { id?: unknown } | null)?.id),
  )
  return [...new Set(ids)].filter(storableId)
}

export function calledWorkflowIds(workflow: Pick<N8nWorkflow, "nodes">): string[] {
  const ids = workflow.nodes
    .filter((n) => /executeWorkflow$/i.test(n.type) && !n.disabled)
    .map((n) => {
      const ref: unknown = n.parameters?.workflowId
      const id = typeof ref === "string" ? ref : (ref as { value?: unknown } | null)?.value
      return typeof id === "string" ? id.replace(/^=/, "") : ""
    })
  return [...new Set(ids)].filter((id) => storableId(id) && !id.includes("{{"))
}

type ExecutionPage = { data: Pick<N8nExecution, "workflowId" | "status" | "startedAt">[]; nextCursor: string | null }
type ExecutionLister = {
  listExecutions(
    query: { limit?: number; cursor?: string; startedAfter?: string },
    signal?: AbortSignal,
  ): Promise<ExecutionPage>
}

const rejectsStartedAfter = (error: unknown) =>
  error instanceof N8nError && error.status === 400 && /startedAfter/.test(error.body ?? "")

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

const SYNCS_AT_ONCE = 2

const READ_DEADLINE_MS = 30 * 60_000
let syncing = 0
const slotWaiters: (() => void)[] = []

async function inSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (syncing < SYNCS_AT_ONCE) syncing += 1
  else await new Promise<void>((take) => slotWaiters.push(take))
  try {
    return await fn()
  } finally {
    const next = slotWaiters.shift()
    if (next) next()
    else syncing -= 1
  }
}

const waiting = new Map<string, Promise<{ workflows: number }>>()
const running = new Set<string>()

const startedAt = new Map<string, number>()

export const workflowSyncBusy = (instanceId: string) => waiting.has(instanceId) || running.has(instanceId)

export const lastWorkflowSync = (instanceId: string) => startedAt.get(instanceId) ?? 0

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
      ids: skipped.slice(0, 10).map((id) => id.slice(0, 100)),
    })
  await ctx.db
    .delete(workflows)
    .where(
      and(eq(workflows.instanceId, instance.id), listed.length ? notInArray(workflows.workflowId, listed) : undefined),
    )
  changed(ctx, "workflows", "instances")
  return { workflows: all.length }
}

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

export function syncWorkflowsSoon(ctx: Ctx, instance: Instance) {
  if (!can(instance, "map") || unsupportedVersion(instance)) return
  void syncWorkflows(ctx, instance).catch((e: Error) =>
    ctx.log.warn("workflow sync failed", { instance: instance.name, error: e.message }),
  )
}

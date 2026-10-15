import { and, eq, notInArray } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { workflows } from "../db/schema.ts"
import { sha256 } from "../lib/crypto.ts"
import type { N8nWorkflow } from "../n8n/client.ts"
import { describeTrigger } from "../n8n/execution.ts"
import { clientFor, type Instance } from "./instances.ts"

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

export function credentialIds(workflow: Pick<N8nWorkflow, "nodes">): string[] {
  return [...new Set(workflow.nodes.flatMap((n) => Object.values(n.credentials ?? {}).map((c) => c.id ?? "")))].filter(
    Boolean,
  )
}

/** Ids of workflows called with Execute Workflow nodes (by id, which breaks when moved). */
export function calledWorkflowIds(workflow: Pick<N8nWorkflow, "nodes">): string[] {
  const ids = workflow.nodes
    .filter((n) => /executeWorkflow$/i.test(n.type) && !n.disabled)
    .map((n) => {
      const ref = n.parameters?.workflowId as string | { value?: string } | undefined
      return typeof ref === "string" ? ref : (ref?.value ?? "")
    })
  return [...new Set(ids.map((id) => String(id).replace(/^=/, "")))].filter((id) => id && !id.includes("{{"))
}

/** Reads every workflow of an instance and its run counts for the last 30 days (requirement F1). */
export async function syncWorkflows(ctx: Ctx, instance: Instance) {
  const client = clientFor(ctx, instance)
  const all = await client.listWorkflows()
  const stats = new Map<string, { runs: number; errors: number; last: Date | null }>()
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  let cursor: string | undefined
  for (let page = 0; page < 40; page++) {
    const res = await client.listExecutions({ limit: 250, cursor, startedAfter: since })
    for (const e of res.data) {
      const s = stats.get(e.workflowId) ?? { runs: 0, errors: 0, last: null }
      s.runs++
      if (e.status === "error" || e.status === "crashed") s.errors++
      const at = e.startedAt ? new Date(e.startedAt) : null
      if (at && (!s.last || at > s.last)) s.last = at
      stats.set(e.workflowId, s)
    }
    if (!res.nextCursor) break
    cursor = res.nextCursor
  }
  for (const w of all) {
    const trigger = describeTrigger(w)
    const s = stats.get(w.id)
    const row = {
      name: w.name,
      active: w.active,
      archived: Boolean(w.isArchived),
      triggerType: trigger.type,
      triggerDetail: trigger.detail,
      structureHash: structureHash(w),
      nodeCount: w.nodes.length,
      credentialIds: credentialIds(w),
      calledWorkflowIds: calledWorkflowIds(w),
      tags: (w.tags ?? []).map((t) => t.name),
      lastRunAt: s?.last ?? null,
      runs30d: s?.runs ?? 0,
      errors30d: s?.errors ?? 0,
      syncedAt: new Date(),
    }
    await ctx.db
      .insert(workflows)
      .values({ instanceId: instance.id, workflowId: w.id, ...row })
      .onConflictDoUpdate({ target: [workflows.instanceId, workflows.workflowId], set: row })
  }
  const ids = all.map((w) => w.id)
  await ctx.db
    .delete(workflows)
    .where(and(eq(workflows.instanceId, instance.id), ids.length ? notInArray(workflows.workflowId, ids) : undefined))
  return { workflows: all.length }
}

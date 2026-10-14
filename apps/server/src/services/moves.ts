import { hasCapability } from "@n8n-ops/shared"
import { eq } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { instances, moves, workerJobs } from "../db/schema.ts"
import { usableWorker } from "./backups.ts"
import { clientFor, effectiveScopes, type Instance } from "./instances.ts"
import { enqueueJob, waitForJob } from "./workers.ts"
import { calledWorkflowIds, credentialIds } from "./workflows.ts"

export type ExportedCredential = { id: string; name: string; type: string; data: Record<string, unknown> }

/** Decrypted credentials of an instance, read by its worker with n8n's CLI. Kept in memory only. */
export async function exportCredentials(ctx: Ctx, instance: Instance, ids?: string[]): Promise<ExportedCredential[]> {
  const worker = await usableWorker(ctx, instance)
  if (!worker)
    throw new Error(`${instance.name} has no worker and container name, so credential secrets cannot be read.`)
  const job = await enqueueJob(
    ctx,
    worker.id,
    "export-credentials",
    { container: instance.containerName, ids: ids ?? null },
    instance.id,
  )
  const outcome = await waitForJob(job.id)
  if (!outcome.ok) throw new Error(outcome.error ?? "The worker could not export the credentials.")
  const credentials = (outcome.result?.credentials ?? []) as ExportedCredential[]
  await ctx.db
    .update(workerJobs)
    .set({ result: { credentials: credentials.length } })
    .where(eq(workerJobs.id, job.id))
  return ids ? credentials.filter((c) => ids.includes(c.id)) : credentials
}

async function load(ctx: Ctx, id: string) {
  const [row] = await ctx.db.select().from(instances).where(eq(instances.id, id))
  if (!row) throw new Error("Instance not found.")
  return row
}

const join = (base: string, path: string) => `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`

/** What a move will do and break, shown before every move (requirement F3). */
export async function previewMove(ctx: Ctx, input: { sourceId: string; targetId: string; workflowId: string }) {
  const [source, target] = await Promise.all([load(ctx, input.sourceId), load(ctx, input.targetId)])
  if (source.id === target.id) throw new Error("Choose a different target instance.")
  const workflow = await clientFor(ctx, source).getWorkflow(input.workflowId)
  const webhooks = workflow.nodes
    .filter((n) => /webhook$/i.test(n.type) && !n.disabled)
    .map((n) => {
      const path = String(n.parameters?.path ?? "")
      return {
        node: n.name,
        from: join(source.baseUrl, `webhook/${path}`),
        to: join(target.baseUrl, `webhook/${path}`),
      }
    })
  const calls = calledWorkflowIds(workflow)
  const creds = workflow.nodes.flatMap((n) =>
    Object.entries(n.credentials ?? {}).map(([type, c]) => ({ id: c.id ?? "", name: c.name ?? type, type })),
  )
  const unique = [...new Map(creds.map((c) => [c.id, c])).values()].filter((c) => c.id)
  const worker = await usableWorker(ctx, source)
  const blockers: string[] = []
  if (!hasCapability("move", effectiveScopes(target), Boolean(target.workerId)))
    blockers.push(`The API key of ${target.name} cannot create and activate workflows and credentials.`)
  if (!hasCapability("moveFrom", effectiveScopes(source), Boolean(source.workerId)))
    blockers.push(`The API key of ${source.name} cannot read and deactivate workflows.`)
  return {
    workflow: { id: workflow.id, name: workflow.name, active: workflow.active, credentialIds: credentialIds(workflow) },
    source: { id: source.id, name: source.name },
    target: { id: target.id, name: target.name },
    webhooks,
    callsWorkflows: calls,
    credentials: unique,
    credentialsWithSecrets: Boolean(worker),
    blockers,
  }
}

/** Moves a workflow: create on target, verify, then deactivate the source. Nothing is deleted. */
export async function runMove(
  ctx: Ctx,
  input: { sourceId: string; targetId: string; workflowId: string },
  actor: string,
) {
  const preview = await previewMove(ctx, input)
  if (preview.blockers.length) throw new Error(preview.blockers.join(" "))
  const [source, target] = await Promise.all([load(ctx, input.sourceId), load(ctx, input.targetId)])
  const from = clientFor(ctx, source)
  const to = clientFor(ctx, target)
  const steps: { step: string; ok: boolean; detail?: string }[] = []
  const [move] = await ctx.db
    .insert(moves)
    .values({
      sourceInstanceId: source.id,
      targetInstanceId: target.id,
      workflowId: input.workflowId,
      workflowName: preview.workflow.name,
      status: "running",
    })
    .returning()
  const record = async (status: "running" | "done" | "failed", newWorkflowId?: string) => {
    if (move)
      await ctx.db
        .update(moves)
        .set({ status, steps, ...(newWorkflowId ? { newWorkflowId } : {}) })
        .where(eq(moves.id, move.id))
  }
  try {
    const workflow = await from.getWorkflow(input.workflowId)
    const idMap = new Map<string, string>()
    if (preview.credentials.length) {
      if (preview.credentialsWithSecrets) {
        const exported = await exportCredentials(
          ctx,
          source,
          preview.credentials.map((c) => c.id),
        )
        for (const cred of exported) {
          const created = await to.createCredential({ name: cred.name, type: cred.type, data: cred.data })
          idMap.set(cred.id, created.id)
          steps.push({ step: `Credential ${cred.name} created`, ok: true, detail: created.id })
        }
      } else {
        steps.push({
          step: "Credentials not copied",
          ok: false,
          detail: `${preview.credentials.map((c) => c.name).join(", ")}: no worker on ${source.name}; set them in n8n`,
        })
      }
    }
    const nodes = workflow.nodes.map((n) => ({
      ...n,
      credentials: n.credentials
        ? Object.fromEntries(
            Object.entries(n.credentials).map(([t, c]) => [t, { ...c, id: c.id ? (idMap.get(c.id) ?? c.id) : c.id }]),
          )
        : undefined,
    }))
    const created = await to.createWorkflow({
      name: workflow.name,
      nodes,
      connections: workflow.connections,
      settings: workflow.settings ?? {},
    })
    steps.push({ step: `Created on ${target.name}`, ok: true, detail: created.id })
    if (workflow.active) {
      await to.activateWorkflow(created.id)
      const check = await to.getWorkflow(created.id)
      if (!check.active) throw new Error(`The copy on ${target.name} did not stay active; the source was left running.`)
      steps.push({ step: `Activated on ${target.name}`, ok: true })
      await from.deactivateWorkflow(workflow.id)
      steps.push({ step: `Deactivated on ${source.name}`, ok: true })
    } else {
      steps.push({ step: "The source was inactive, so the copy stays inactive", ok: true })
    }
    await record("done", created.id)
    await ctx.audit({
      actor,
      action: "Workflow moved",
      target: `${workflow.name}: ${source.name} -> ${target.name}`,
      via: "web",
      details: { steps },
    })
    return { newWorkflowId: created.id, steps }
  } catch (error) {
    steps.push({ step: "Stopped", ok: false, detail: (error as Error).message })
    await record("failed")
    await ctx.audit({
      actor,
      action: "Workflow move failed",
      target: `${preview.workflow.name}: ${source.name} -> ${target.name}`,
      via: "web",
      details: { steps },
    })
    throw Object.assign(new Error((error as Error).message), { steps })
  }
}

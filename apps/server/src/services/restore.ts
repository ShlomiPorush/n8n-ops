// Restore of single items from an archive (requirement D6): browse what an archive holds, compare it with the
// instance, and restore one workflow (as an inactive copy) or one credential, after a review the confirm must match.
// The private key is used in memory for one request and never stored; credential secrets never leave the server.
import { randomBytes } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { entryText, unsupportedVersionText } from "@n8n-ops/shared"
import { type Manifest, openArchive } from "@n8n-ops/shared/archive"
import { and, desc, eq, inArray, lt } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { backupRuns, instances, restores } from "../db/schema.ts"
import type { AuditVia } from "../lib/audit.ts"
import type { WorkflowFields } from "../lib/n8n-spec.ts"
import {
  type N8nClient,
  type N8nCredential,
  N8nError,
  type N8nNode,
  type N8nWorkflow,
  type WorkflowBody,
} from "../n8n/client.ts"
import { instanceWorkflowFields } from "./access.ts"
import { maxArchiveBytes, readArchive } from "./backups.ts"
import { can, clientFor, effectiveScopes, type Instance, isActive, unsupportedVersion } from "./instances.ts"
import type {
  CredentialAction,
  PlannedStep,
  RestoreKind,
  RestorePlan,
  RestoreStatus,
  RestoreStep,
} from "./restore-types.ts"

export type ArchivedCredential = {
  id: string
  name: string
  type: string
  createdAt?: string
  data?: Record<string, unknown>
}

export class RestoreError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid" | "changed" = "invalid",
  ) {
    super(message)
  }
}

/** How long a review waits for its confirm before it is dropped. */
export const REVIEW_TTL_MS = 60 * 60_000
/** Longest name n8n takes for a workflow or a credential. */
export const NAME_LIMIT = 128
const EXECUTE_WORKFLOW = "n8n-nodes-base.executeWorkflow"
/** Restores confirmed before this process started and still pending were cut off by a restart. */
const processStartedAt = new Date()

// ---------------------------------------------------------------------------
// Reading the archive
// ---------------------------------------------------------------------------

export type OpenedArchive = {
  run: typeof backupRuns.$inferSelect
  manifest: Manifest | null
  workflows: N8nWorkflow[]
  credentials: ArchivedCredential[]
}

/** Reads and opens a run's archive with the pasted key, in memory. */
export async function loadArchive(ctx: Ctx, runId: string, privateKey: string): Promise<OpenedArchive> {
  const [run] = await ctx.db.select().from(backupRuns).where(eq(backupRuns.id, runId))
  if (!run || (run.status !== "ok" && run.status !== "partial"))
    throw new RestoreError("This archive is not available.", "not_found")
  const bytes = await readArchive(ctx, run)
  let entries: Awaited<ReturnType<typeof openArchive>>
  try {
    // The unpacked archive may not exceed the largest archive allowed, so a hostile one cannot fill the memory.
    entries = await openArchive(bytes, privateKey, await maxArchiveBytes(ctx))
  } catch (error) {
    throw new RestoreError(`Cannot open the archive with this key: ${(error as Error).message}`)
  }
  const json = <T>(prefix: string) =>
    entries
      .filter((e) => e.name.startsWith(prefix) && e.name.endsWith(".json"))
      .map((e) => JSON.parse(entryText(e)) as T)
  const manifestEntry = entries.find((e) => e.name === "manifest.json")
  return {
    run,
    manifest: manifestEntry ? (JSON.parse(entryText(manifestEntry)) as Manifest) : null,
    workflows: json<N8nWorkflow>("workflows/").filter((w) => w && typeof w.id === "string" && Array.isArray(w.nodes)),
    credentials: json<ArchivedCredential>("credentials/").filter((c) => c && typeof c.id === "string"),
  }
}

// ---------------------------------------------------------------------------
// Credential references, including those inside embedded sub-workflows
// ---------------------------------------------------------------------------

export type CredentialRef = { type: string; id: string | null; name: string | null; embedded: boolean }

/** The workflow an Execute Workflow node runs from its own parameter, as n8n reads it: only with source "parameter". */
function embeddedSource(node: N8nNode): { text: string } | null {
  if (node.type !== EXECUTE_WORKFLOW) return null
  const params = node.parameters ?? {}
  if (params.source !== "parameter" || typeof params.workflowJson !== "string") return null
  return params.workflowJson.trim() ? { text: params.workflowJson } : null
}

function parseEmbedded(text: string): { nodes: N8nNode[] } | "expression" | "unreadable" {
  if (text.trimStart().startsWith("=")) return "expression"
  try {
    const parsed = JSON.parse(text) as { nodes?: unknown }
    return parsed && Array.isArray(parsed.nodes) ? (parsed as { nodes: N8nNode[] }) : "unreadable"
  } catch {
    return "unreadable"
  }
}

/** Every credential reference in the nodes, embedded sub-workflows included, with warnings for what cannot be read. */
export function credentialRefs(nodes: N8nNode[], warnings: string[] = [], embedded = false, depth = 0) {
  const refs: CredentialRef[] = []
  for (const node of nodes ?? []) {
    for (const [type, ref] of Object.entries(node.credentials ?? {}))
      refs.push({ type, id: ref?.id ?? null, name: ref?.name ?? null, embedded })
    const source = embeddedSource(node)
    if (!source || depth > 5) continue
    const inner = parseEmbedded(source.text)
    if (inner === "expression")
      warnings.push(`"${node.name}" runs a workflow from an expression; credentials inside it are left as they are.`)
    else if (inner === "unreadable")
      warnings.push(`"${node.name}" holds a workflow that cannot be read; credentials inside it are left as they are.`)
    else refs.push(...credentialRefs(inner.nodes, warnings, true, depth + 1))
  }
  return refs
}

type RefChange = { id: string; name: string } | null | undefined

/**
 * The nodes with each credential reference replaced (`{id, name}`), removed as a whole (null, so n8n cannot bind
 * it to another credential by name) or kept (undefined), embedded sub-workflows included.
 */
export function mapCredentialRefs(nodes: N8nNode[], change: (ref: CredentialRef) => RefChange, depth = 0): N8nNode[] {
  return nodes.map((node) => {
    let next: N8nNode = node
    if (node.credentials) {
      const credentials: NonNullable<N8nNode["credentials"]> = {}
      for (const [type, ref] of Object.entries(node.credentials)) {
        const to = change({ type, id: ref?.id ?? null, name: ref?.name ?? null, embedded: depth > 0 })
        if (to === undefined) credentials[type] = ref
        else if (to) credentials[type] = { ...ref, id: to.id, name: to.name }
      }
      next = { ...node, credentials }
      if (Object.keys(credentials).length === 0) delete next.credentials
    }
    const source = embeddedSource(node)
    if (source && depth <= 5) {
      const inner = parseEmbedded(source.text)
      if (typeof inner === "object") {
        const mapped = mapCredentialRefs(inner.nodes, change, depth + 1)
        if (!isDeepStrictEqual(mapped, inner.nodes))
          next = {
            ...next,
            parameters: { ...next.parameters, workflowJson: JSON.stringify({ ...inner, nodes: mapped }, null, 2) },
          }
      }
    }
    return next
  })
}

const refKey = (ref: Pick<CredentialRef, "type" | "id" | "name">) =>
  ref.id ? `id:${ref.id}` : `name:${ref.type}:${ref.name}`

// ---------------------------------------------------------------------------
// Browsing and comparing
// ---------------------------------------------------------------------------

export type WorkflowSummary = {
  id: string
  name: string
  active: boolean
  archived: boolean
  tags: string[]
  createdAt: string | null
  updatedAt: string | null
  versionId: string | null
  nodes: number
  credentials: {
    id: string | null
    name: string
    type: string
    inArchive: boolean
    hasSecrets: boolean
    embedded: boolean
  }[]
  /** Execute Workflow nodes that run a workflow kept in the node itself. */
  embedded: number
}

export type ChangeKind =
  | "definition"
  | "layout"
  | "settings"
  | "name"
  | "description"
  | "staticData"
  | "pinData"
  | "published"
  | "archived"

export type Comparison =
  | {
      available: true
      instance: string
      at: string
      workflows: Record<string, { state: "same" | "changed" | "not_found"; changes: ChangeKind[] }>
    }
  | { available: false; reason: string }

const shape = (nodes: N8nNode[]) =>
  [...(nodes ?? [])]
    .map(({ position: _p, ...rest }: N8nNode & { position?: unknown }) => rest)
    .sort((a, b) => a.name.localeCompare(b.name))
const positions = (nodes: N8nNode[]) =>
  Object.fromEntries((nodes ?? []).map((n) => [n.name, (n as N8nNode & { position?: unknown }).position ?? null]))

/** What differs between the archived workflow and the one on the instance; a field the instance does not return is not compared. */
export function workflowChanges(archived: N8nWorkflow, live: N8nWorkflow): ChangeKind[] {
  const out: ChangeKind[] = []
  const has = (k: keyof N8nWorkflow) => k in live
  if (
    !isDeepStrictEqual(shape(archived.nodes), shape(live.nodes)) ||
    !isDeepStrictEqual(archived.connections ?? {}, live.connections ?? {}) ||
    (has("nodeGroups") && !isDeepStrictEqual(archived.nodeGroups ?? null, live.nodeGroups ?? null))
  )
    out.push("definition")
  else if (!isDeepStrictEqual(positions(archived.nodes), positions(live.nodes))) out.push("layout")
  if (has("settings") && !isDeepStrictEqual(archived.settings ?? {}, live.settings ?? {})) out.push("settings")
  if (archived.name !== live.name) out.push("name")
  if (has("description") && (archived.description ?? null) !== (live.description ?? null)) out.push("description")
  if (has("staticData") && !isDeepStrictEqual(archived.staticData ?? null, live.staticData ?? null))
    out.push("staticData")
  if (has("pinData") && !isDeepStrictEqual(archived.pinData ?? null, live.pinData ?? null)) out.push("pinData")
  if (Boolean(archived.active) !== Boolean(live.active)) out.push("published")
  if (live.isArchived && !archived.isArchived) out.push("archived")
  return out
}

export type CredentialSummary = {
  id: string
  name: string
  type: string
  createdAt: string | null
  hasSecrets: boolean
  usedBy: string[]
}

function summarize(archive: OpenedArchive): { workflows: WorkflowSummary[]; credentials: CredentialSummary[] } {
  const creds = new Map(archive.credentials.map((c) => [c.id, c]))
  const usedBy = new Map<string, string[]>()
  const workflows = archive.workflows
    .map((w): WorkflowSummary => {
      const seen = new Map<string, WorkflowSummary["credentials"][number]>()
      for (const ref of credentialRefs(w.nodes)) {
        const key = refKey(ref)
        if (seen.has(key)) continue
        const archived = ref.id ? creds.get(ref.id) : undefined
        seen.set(key, {
          id: ref.id,
          name: archived?.name ?? ref.name ?? ref.id ?? "?",
          type: archived?.type ?? ref.type,
          inArchive: Boolean(archived),
          hasSecrets: Boolean(archived?.data),
          embedded: ref.embedded,
        })
        if (ref.id) usedBy.set(ref.id, [...(usedBy.get(ref.id) ?? []), w.id])
      }
      return {
        id: w.id,
        name: w.name,
        active: Boolean(w.active),
        archived: Boolean(w.isArchived),
        tags: (w.tags ?? []).map((t) => (typeof t === "string" ? t : t.name)),
        createdAt: w.createdAt ?? null,
        updatedAt: w.updatedAt ?? null,
        versionId: w.versionId ?? null,
        nodes: w.nodes.length,
        credentials: [...seen.values()],
        embedded: w.nodes.filter((n) => embeddedSource(n)).length,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  const credentials = archive.credentials
    .map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      createdAt: c.createdAt ?? null,
      hasSecrets: Boolean(c.data),
      usedBy: [...new Set(usedBy.get(c.id) ?? [])],
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { workflows, credentials }
}

async function compareWithInstance(ctx: Ctx, archive: OpenedArchive): Promise<Comparison> {
  if (!archive.run.instanceId) return { available: false, reason: "This archive is not of an n8n instance." }
  const [instance] = await ctx.db.select().from(instances).where(eq(instances.id, archive.run.instanceId))
  if (!instance) return { available: false, reason: "The instance of this archive was removed." }
  if (!isActive(instance)) return { available: false, reason: `${instance.name} has not finished its setup.` }
  if (!instance.apiKeyEnc) return { available: false, reason: `${instance.name} has no API key.` }
  if (unsupportedVersion(instance)) return { available: false, reason: unsupportedVersionText }
  const scopes = effectiveScopes(instance)
  if (!scopes.includes("workflow:list") || !scopes.includes("workflow:read"))
    return {
      available: false,
      reason: `The API key of ${instance.name} cannot read workflows (workflow:list, workflow:read).`,
    }
  let live: N8nWorkflow[]
  try {
    live = await clientFor(ctx, instance).listWorkflows()
  } catch (error) {
    return { available: false, reason: `${instance.name} could not be read: ${n8nMessage(error)}` }
  }
  const byId = new Map(live.map((w) => [w.id, w]))
  const workflows: Extract<Comparison, { available: true }>["workflows"] = {}
  for (const w of archive.workflows) {
    const now = byId.get(w.id)
    if (!now) workflows[w.id] = { state: "not_found", changes: [] }
    else {
      const changes = workflowChanges(w, now)
      workflows[w.id] = { state: changes.length ? "changed" : "same", changes }
    }
  }
  return { available: true, instance: instance.name, at: new Date().toISOString(), workflows }
}

/** What an archive holds, in summaries, compared with its instance where that can be read. */
export async function inspectArchive(ctx: Ctx, runId: string, privateKey: string) {
  const archive = await loadArchive(ctx, runId, privateKey)
  const { workflows, credentials } = summarize(archive)
  return {
    run: { id: archive.run.id, instanceId: archive.run.instanceId, startedAt: archive.run.startedAt },
    manifest: archive.manifest,
    workflows,
    credentials,
    comparison: await compareWithInstance(ctx, archive),
  }
}

/** One archived workflow in full, for reading and download. Credentials are never returned with their data. */
export async function archivedWorkflow(ctx: Ctx, runId: string, privateKey: string, workflowId: string) {
  const archive = await loadArchive(ctx, runId, privateKey)
  const workflow = archive.workflows.find((w) => w.id === workflowId)
  if (!workflow) throw new RestoreError("This workflow is not in the archive.", "not_found")
  return workflow
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/** The name an item is created with: the base shortened so the whole name fits n8n's limit. */
export function restoredName(base: string, date: string, code: string, step: number) {
  const suffix = ` (restored ${date} ${code}-${step})`
  const chars = [...base]
  const room = NAME_LIMIT - suffix.length
  const short = chars.length > room ? `${chars.slice(0, Math.max(0, room - 1)).join("")}…` : base
  return `${short}${suffix}`
}

const sameTime = (a?: string | null, b?: string | null) =>
  Boolean(a && b) && new Date(a as string).getTime() === new Date(b as string).getTime()

export type ResolveInput = {
  refs: CredentialRef[]
  archived: Map<string, ArchivedCredential>
  sameInstance: boolean
  /** The target's credentials; a string when they could not be listed (why). */
  live: N8nCredential[] | string
  targetName: string
  firstStep: number
}

/** What happens to each credential a workflow uses (owner decision: link one that still exists, create only missing). */
export function resolveCredentials({ refs, archived, sameInstance, live, targetName, firstStep }: ResolveInput) {
  const actions: CredentialAction[] = []
  const seen = new Set<string>()
  let step = firstStep
  for (const ref of refs) {
    const key = refKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    const source = ref.id ? archived.get(ref.id) : undefined
    const type = source?.type ?? ref.type
    const name = source?.name ?? ref.name ?? ref.id ?? "?"
    const base = { sourceId: ref.id, name, type, embedded: ref.embedded }
    const create = () => {
      if (ref.id && source?.data) {
        actions.push({ ...base, sourceId: ref.id, action: "create", step: step++ })
        return true
      }
      return false
    }
    if (sameInstance) {
      if (!ref.id) {
        actions.push({ ...base, action: "keep", reason: "The workflow names it without an ID; n8n finds it by name." })
        continue
      }
      if (typeof live === "string") {
        actions.push({ ...base, action: "keep", reason: `Not checked: ${live}` })
        continue
      }
      const found = live.find((c) => c.id === ref.id && c.type === type)
      const createdKnown = Boolean(source?.createdAt && found?.createdAt)
      if (found && (!createdKnown || sameTime(source?.createdAt, found.createdAt))) {
        actions.push({
          ...base,
          sourceId: ref.id,
          action: "link",
          targetId: found.id,
          matchedBy: createdKnown ? "id_type_created" : "id_type",
        })
        continue
      }
      if (create()) continue
      actions.push({
        ...base,
        action: "remove",
        reason: source
          ? `Not on ${targetName}, and the archive has no secrets for it; set it in n8n.`
          : `Not on ${targetName}, and not in the archive; set it in n8n.`,
      })
      continue
    }
    if (create()) continue
    actions.push({
      ...base,
      action: "remove",
      reason: source ? "The archive has no secrets for it; set it in n8n." : "Not in the archive; set it in n8n.",
    })
  }
  return { actions, nextStep: step }
}

const OPTIONAL_FIELDS = ["nodeGroups", "description", "pinData"] as const

/** The body a copy is created with, and what of the archived workflow it leaves out. */
export function copyBody(
  workflow: N8nWorkflow,
  name: string,
  fields: WorkflowFields | null,
): { body: WorkflowBody; notRestored: string[] } {
  const notRestored: string[] = []
  const settings = { ...(workflow.settings ?? {}) }
  if (fields?.settings) {
    for (const key of Object.keys(settings))
      if (!fields.settings.includes(key)) {
        delete settings[key]
        notRestored.push(`settings.${key}: this n8n does not take it`)
      }
  }
  const body: WorkflowBody = { name, nodes: workflow.nodes, connections: workflow.connections ?? {}, settings }
  for (const field of OPTIONAL_FIELDS) {
    const value = workflow[field]
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      (typeof value === "object" && Object.keys(value).length === 0)
    )
      continue
    if (fields?.fields.includes(field)) Object.assign(body, { [field]: value })
    else notRestored.push(`${field}: ${fields ? "this n8n does not take it" : "this n8n does not say it takes it"}`)
  }
  if (workflow.staticData && Object.keys(workflow.staticData as object).length > 0)
    notRestored.push("staticData: polling state is never restored")
  if ((workflow.tags ?? []).length > 0) notRestored.push("tags: not restored")
  return { body, notRestored }
}

type Target = Instance

async function targetFor(ctx: Ctx, targetInstanceId: string): Promise<Target> {
  const [target] = await ctx.db.select().from(instances).where(eq(instances.id, targetInstanceId))
  if (!target) throw new RestoreError("Target instance not found.", "not_found")
  if (!can(target, "restore"))
    throw new RestoreError(
      `${target.name} is not set up to restore workflows. Add Restore workflows to its capabilities.`,
    )
  if (unsupportedVersion(target)) throw new RestoreError(unsupportedVersionText)
  return target
}

async function workflowFieldsOf(ctx: Ctx, target: Target) {
  try {
    return await instanceWorkflowFields(ctx, target)
  } catch {
    return null
  }
}

/** The plan of a restore, computed the same way at review and at confirm. Writes nothing. */
async function buildPlan(
  ctx: Ctx,
  archive: OpenedArchive,
  target: Target,
  item: { kind: RestoreKind; id: string },
  code: string,
  date: string,
  restoreId: string | null,
): Promise<{ plan: RestorePlan; workflow?: N8nWorkflow; client: N8nClient }> {
  const client = clientFor(ctx, target)
  const sameInstance = archive.run.instanceId === target.id
  const archived = new Map(archive.credentials.map((c) => [c.id, c]))
  const warnings: string[] = []
  let plan: Omit<RestorePlan, "earlierUnknown">
  let workflow: N8nWorkflow | undefined
  if (item.kind === "credential") {
    const credential = archived.get(item.id)
    if (!credential) throw new RestoreError("This credential is not in the archive.", "not_found")
    if (!credential.data)
      throw new RestoreError(
        `The archive has no secrets for ${credential.name}; n8n cannot take a credential without them.`,
      )
    plan = {
      target: { id: target.id, name: target.name, sameInstance },
      item: { kind: "credential", id: credential.id, name: credential.name },
      mode: "copy",
      date,
      credentials: [],
      steps: [
        {
          step: 1,
          kind: "credential",
          sourceId: credential.id,
          name: restoredName(credential.name, date, code, 1),
          type: credential.type,
        },
      ],
      notRestored: [],
      warnings,
    }
  } else {
    workflow = archive.workflows.find((w) => w.id === item.id)
    if (!workflow) throw new RestoreError("This workflow is not in the archive.", "not_found")
    const refs = credentialRefs(workflow.nodes, warnings)
    let live: N8nCredential[] | string = "the API key cannot list credentials (credential:list)."
    if (sameInstance && refs.length > 0 && effectiveScopes(target).includes("credential:list")) {
      try {
        live = await client.listCredentials()
      } catch (error) {
        live = `the credentials could not be listed: ${n8nMessage(error)}`
      }
    }
    const { actions, nextStep } = resolveCredentials({
      refs,
      archived,
      sameInstance,
      live,
      targetName: target.name,
      firstStep: 1,
    })
    const steps: PlannedStep[] = actions.flatMap((a) =>
      a.action === "create"
        ? [
            {
              step: a.step,
              kind: "credential" as const,
              sourceId: a.sourceId,
              name: restoredName(a.name, date, code, a.step),
              type: a.type,
            },
          ]
        : [],
    )
    const name = restoredName(workflow.name, date, code, nextStep)
    steps.push({ step: nextStep, kind: "workflow", sourceId: workflow.id, name })
    const { notRestored } = copyBody(workflow, name, await workflowFieldsOf(ctx, target))
    plan = {
      target: { id: target.id, name: target.name, sameInstance },
      item: { kind: "workflow", id: workflow.id, name: workflow.name },
      mode: "copy",
      date,
      credentials: actions,
      steps,
      notRestored,
      warnings,
    }
  }
  const unknown = await ctx.db
    .select({ id: restores.id, createdAt: restores.createdAt, steps: restores.steps })
    .from(restores)
    .where(
      and(
        eq(restores.targetInstanceId, target.id),
        eq(restores.kind, item.kind),
        eq(restores.itemId, item.id),
        eq(restores.status, "unknown"),
      ),
    )
    .orderBy(desc(restores.createdAt))
  const earlierUnknown = unknown
    .filter((r) => r.id !== restoreId)
    .map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      created: r.steps.filter((s) => s.status === "done").map((s) => s.name),
    }))
  return { plan: { ...plan, earlierUnknown }, workflow, client }
}

export type RestoreActor = { actor: string; via: AuditVia }

/** Reviews a restore: stores what it will do (no key, no secrets) and returns it with the restore's ID. */
export async function previewRestore(
  ctx: Ctx,
  input: {
    runId: string
    privateKey: string
    targetInstanceId: string
    kind: RestoreKind
    itemId: string
  } & RestoreActor,
) {
  const target = await targetFor(ctx, input.targetInstanceId)
  const archive = await loadArchive(ctx, input.runId, input.privateKey)
  const date = new Date().toISOString().slice(0, 10)
  for (let attempt = 0; ; attempt++) {
    const code = randomBytes(4).toString("hex")
    const { plan } = await buildPlan(ctx, archive, target, { kind: input.kind, id: input.itemId }, code, date, null)
    const [row] = await ctx.db
      .insert(restores)
      .values({
        code,
        actor: input.actor,
        via: input.via,
        runId: archive.run.id,
        targetInstanceId: target.id,
        kind: input.kind,
        itemId: input.itemId,
        itemName: plan.item.name,
        mode: "copy",
        status: "previewed",
        reviewed: plan,
      })
      .onConflictDoNothing({ target: restores.code })
      .returning()
    if (row) return view(row)
    if (attempt >= 4) throw new Error("Could not reserve a restore code.")
  }
}

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

type Row = typeof restores.$inferSelect

export function view(row: Row) {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    kind: row.kind,
    itemId: row.itemId,
    itemName: row.itemName,
    mode: row.mode,
    runId: row.runId,
    targetInstanceId: row.targetInstanceId,
    actor: row.actor,
    plan: row.reviewed,
    steps: row.steps,
    error: row.error,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
    finishedAt: row.finishedAt,
    expiresAt: row.status === "previewed" ? new Date(row.createdAt.getTime() + REVIEW_TTL_MS) : null,
  }
}

const actions: Record<Exclude<RestoreStatus, "previewed" | "pending">, Record<RestoreKind, string>> = {
  done: { workflow: "Workflow restored", credential: "Credential restored" },
  failed: { workflow: "Workflow restore failed", credential: "Credential restore failed" },
  unknown: { workflow: "Workflow restore unknown", credential: "Credential restore unknown" },
}

/** Ends a restore and writes its audit entry in the same transaction, with the person who confirmed it. */
async function finish(
  ctx: Ctx,
  row: Row,
  status: "done" | "failed" | "unknown",
  steps: RestoreStep[],
  error: string | null,
  note?: string,
) {
  return ctx.db.transaction(async (tx) => {
    const [saved] = await tx
      .update(restores)
      .set({ status, steps, error, finishedAt: new Date() })
      .where(eq(restores.id, row.id))
      .returning()
    await ctx.audit(
      {
        actor: row.actor,
        action: actions[status][row.kind],
        target: `${row.itemName} into ${row.reviewed.target.name}`,
        via: row.via as AuditVia,
        details: {
          restoreId: row.id,
          runId: row.runId,
          mode: row.mode,
          steps: steps.map(({ step, kind, name, status: s, createdId, error: e }) => ({
            step,
            kind,
            name,
            status: s,
            createdId,
            error: e,
          })),
          ...(error ? { error } : {}),
          ...(note ? { note } : {}),
        },
      },
      tx,
    )
    return saved as Row
  })
}

export function n8nMessage(error: unknown) {
  if (error instanceof N8nError) {
    try {
      const body = JSON.parse(error.body ?? "") as { message?: string }
      if (body.message) return `${error.message}: ${body.message}`
    } catch {
      // Not JSON.
    }
    return error.message
  }
  return (error as Error)?.message ?? String(error)
}

/** Finds what a step would have created, by its exact name: the ID, null when n8n has none, undefined when unclear. */
async function findCreated(client: N8nClient, step: PlannedStep): Promise<string | null | undefined> {
  try {
    const matches =
      step.kind === "credential"
        ? (await client.listCredentials()).filter((c) => c.name === step.name && c.type === step.type)
        : (await client.listWorkflows(step.name)).filter((w) => w.name === step.name)
    if (matches.length === 1) return matches[0]?.id
    return matches.length === 0 ? null : undefined
  } catch {
    return undefined
  }
}

/**
 * One creation in n8n. Any error is followed by a read of what it would have created: n8n can save and then fail
 * (an after-save hook), and a request cut off may still land. Proven written is done; not written after a full
 * answer is failed; anything else is unknown.
 */
async function runStep(
  client: N8nClient,
  step: PlannedStep,
  write: () => Promise<{ id: string }>,
): Promise<RestoreStep> {
  try {
    const created = await write()
    return { ...step, status: "done", createdId: created.id }
  } catch (error) {
    const message = n8nMessage(error)
    const found = await findCreated(client, step)
    if (typeof found === "string")
      return {
        ...step,
        status: "done",
        createdId: found,
        error: `n8n answered with an error but created it: ${message}`,
      }
    if (found === null && error instanceof N8nError) return { ...step, status: "failed", error: message }
    return { ...step, status: "unknown", error: message }
  }
}

/** Runs a reviewed restore once. A second confirm, or one for a restore already running or ended, returns it as it is. */
export async function confirmRestore(ctx: Ctx, restoreId: string, privateKey: string) {
  const [row] = await ctx.db
    .update(restores)
    .set({ status: "pending", confirmedAt: new Date() })
    .where(and(eq(restores.id, restoreId), eq(restores.status, "previewed")))
    .returning()
  if (!row) {
    const [current] = await ctx.db.select().from(restores).where(eq(restores.id, restoreId))
    if (!current) throw new RestoreError("This review has expired or was closed. Open the archive again.", "not_found")
    return view(current)
  }
  if (row.createdAt.getTime() + REVIEW_TTL_MS < Date.now())
    return view(await finish(ctx, row, "failed", [], "The review expired before it was confirmed. Review it again."))
  const steps: RestoreStep[] = row.reviewed.steps.map((s) => ({ ...s, status: "todo" }))
  // Stored at once, so a restart from here on leaves the steps to check.
  await ctx.db.update(restores).set({ steps }).where(eq(restores.id, row.id))
  let built: Awaited<ReturnType<typeof buildPlan>>
  let archive: OpenedArchive
  let target: Target
  try {
    if (!row.runId) throw new RestoreError("The archive of this review is gone.")
    target = await targetFor(ctx, row.targetInstanceId)
    archive = await loadArchive(ctx, row.runId, privateKey)
    built = await buildPlan(
      ctx,
      archive,
      target,
      { kind: row.kind, id: row.itemId },
      row.code,
      row.reviewed.date,
      row.id,
    )
  } catch (error) {
    return view(await finish(ctx, row, "failed", steps, (error as Error).message))
  }
  if (!isDeepStrictEqual(built.plan, row.reviewed))
    return view(
      await finish(ctx, row, "failed", steps, "Something changed since you reviewed this restore. Review it again."),
    )
  const { plan, workflow, client } = built
  const ids = new Map<string, { id: string; name: string }>()
  for (const a of plan.credentials)
    if (a.action === "link") ids.set(`id:${a.sourceId}`, { id: a.targetId, name: a.name })
  const removed = new Set(
    plan.credentials
      .filter((a) => a.action === "remove")
      .map((a) => refKey({ type: a.type, id: a.sourceId, name: a.name })),
  )
  const archived = new Map(archive.credentials.map((c) => [c.id, c]))
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as RestoreStep
    let result: RestoreStep
    if (step.kind === "credential") {
      const source = archived.get(step.sourceId)
      result = await runStep(client, step, () =>
        client.createCredential({ name: step.name, type: step.type ?? source?.type ?? "", data: source?.data ?? {} }),
      )
      if (result.createdId) ids.set(`id:${step.sourceId}`, { id: result.createdId, name: step.name })
    } else {
      const nodes = mapCredentialRefs(workflow?.nodes ?? [], (ref) =>
        removed.has(refKey(ref)) ? null : ids.get(refKey(ref)),
      )
      const { body } = copyBody({ ...(workflow as N8nWorkflow), nodes }, step.name, await workflowFieldsOf(ctx, target))
      result = await runStep(client, step, () => client.createWorkflow(body))
    }
    steps[i] = result
    await ctx.db.update(restores).set({ steps }).where(eq(restores.id, row.id))
    if (result.status !== "done")
      return view(
        await finish(ctx, row, result.status === "failed" ? "failed" : "unknown", steps, result.error ?? null),
      )
  }
  return view(await finish(ctx, row, "done", steps, null))
}

/**
 * "Check and try again" for a restore whose outcome is unknown: reads n8n for each step's exact name. It ends done
 * only when every step is proven written; not found does not prove a failure, so the restore stays unknown.
 */
export async function checkRestore(ctx: Ctx, restoreId: string) {
  const [row] = await ctx.db.select().from(restores).where(eq(restores.id, restoreId))
  if (!row) throw new RestoreError("Restore not found.", "not_found")
  if (row.status !== "unknown") return view(row)
  const [target] = await ctx.db.select().from(instances).where(eq(instances.id, row.targetInstanceId))
  if (!target) throw new RestoreError("Target instance not found.", "not_found")
  const client = clientFor(ctx, target)
  const steps = [...row.steps]
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as RestoreStep
    if (step.status === "done") continue
    const found = await findCreated(client, step)
    if (typeof found === "string") steps[i] = { ...step, status: "done", createdId: found }
    else if (step.status === "unknown")
      steps[i] = {
        ...step,
        error: found === null ? "Not found yet, which does not prove it failed." : "Could not be checked now.",
      }
  }
  if (steps.every((s) => s.status === "done"))
    return view(await finish(ctx, row, "done", steps, null, "Confirmed by checking n8n."))
  const [saved] = await ctx.db.update(restores).set({ steps }).where(eq(restores.id, row.id)).returning()
  return view(saved as Row)
}

export async function getRestore(ctx: Ctx, restoreId: string) {
  const [row] = await ctx.db.select().from(restores).where(eq(restores.id, restoreId))
  return row ? view(row) : null
}

/** Recent restores into an instance, newest first; reviews not confirmed are not listed. */
export async function recentRestores(ctx: Ctx, targetInstanceId: string, limit = 20) {
  const rows = await ctx.db
    .select()
    .from(restores)
    .where(
      and(
        eq(restores.targetInstanceId, targetInstanceId),
        inArray(restores.status, ["pending", "done", "failed", "unknown"]),
      ),
    )
    .orderBy(desc(restores.createdAt))
    .limit(limit)
  return rows.map(view)
}

/** Drops a review that was not confirmed (closing the page). Anything else stays. */
export async function dropReview(ctx: Ctx, restoreId: string) {
  await ctx.db.delete(restores).where(and(eq(restores.id, restoreId), eq(restores.status, "previewed")))
}

/**
 * Scheduled: reviews older than an hour leave (they never wrote anything), and restores cut off by a restart become
 * unknown, with their audit entry.
 */
export async function sweepRestores(ctx: Ctx) {
  await ctx.db
    .delete(restores)
    .where(and(eq(restores.status, "previewed"), lt(restores.createdAt, new Date(Date.now() - REVIEW_TTL_MS))))
  const cut = await ctx.db
    .select()
    .from(restores)
    .where(and(eq(restores.status, "pending"), lt(restores.confirmedAt, processStartedAt)))
  for (const row of cut) {
    const steps: RestoreStep[] = row.steps.length
      ? [...row.steps]
      : row.reviewed.steps.map((s) => ({ ...s, status: "todo" }))
    // The step that was running when the server stopped may have been written.
    const running = steps.findIndex((s) => s.status === "todo")
    if (running >= 0) steps[running] = { ...(steps[running] as RestoreStep), status: "unknown" }
    await finish(ctx, row, "unknown", steps, "n8n-ops restarted during this restore. Check n8n before trying again.")
  }
}

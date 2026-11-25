import { createHash, randomBytes } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { createTar, entryText, textEntry, unsupportedVersionText } from "@n8n-ops/shared"
import { type Manifest, openArchive, sealArchive, sha256Base64 } from "@n8n-ops/shared/archive"
import { identityToRecipient } from "age-encryption"
import { and, desc, eq, getTableColumns, inArray, lt } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { backupRuns, instances, restores } from "../db/schema.ts"
import type { AuditVia } from "../lib/audit.ts"
import type { WorkflowFields } from "../lib/n8n-spec.ts"
import { oneAtATime } from "../lib/one-at-a-time.ts"
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
import {
  can,
  clientFor,
  compareVersions,
  effectiveScopes,
  type Instance,
  isActive,
  unsupportedVersion,
} from "./instances.ts"
import type {
  CredentialAction,
  PlannedStep,
  ReplacePlan,
  RestoreKind,
  RestoreMode,
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
    readonly code: "not_found" | "invalid" = "invalid",
  ) {
    super(message)
  }
}

export const REVIEW_TTL_MS = 60 * 60_000
export const NAME_LIMIT = 128
const EXECUTE_WORKFLOW = "n8n-nodes-base.executeWorkflow"

export type ArchiveSource = { runId: string } | { versionOf: string }

export type OpenedArchive = {
  source: { kind: "run" | "version"; id: string; instanceId: string | null; at: Date }
  manifest: Manifest | null
  workflows: N8nWorkflow[]
  credentials: ArchivedCredential[]
}

export function loadArchive(ctx: Ctx, source: ArchiveSource, privateKey: string): Promise<OpenedArchive> {
  return "runId" in source ? loadRun(ctx, source.runId, privateKey) : loadVersion(ctx, source.versionOf, privateKey)
}

async function loadRun(ctx: Ctx, runId: string, privateKey: string): Promise<OpenedArchive> {
  const [run] = await ctx.db.select().from(backupRuns).where(eq(backupRuns.id, runId))
  if (!run || (run.status !== "ok" && run.status !== "partial"))
    throw new RestoreError("This archive is not available.", "not_found")
  let bytes: Uint8Array
  try {
    bytes = await readArchive(ctx, run)
  } catch (error) {
    throw new RestoreError((error as Error).message, "not_found")
  }
  return {
    source: { kind: "run", id: run.id, instanceId: run.instanceId, at: run.startedAt },
    ...(await unpack(ctx, bytes, privateKey)),
  }
}

async function loadVersion(ctx: Ctx, restoreId: string, privateKey: string): Promise<OpenedArchive> {
  const [row] = await ctx.db.select().from(restores).where(eq(restores.id, restoreId))
  if (!row?.beforeArchive || !row.beforeSha256 || !row.beforeTakenAt)
    throw new RestoreError("This restore kept no version before.", "not_found")
  const bytes = new Uint8Array(Buffer.from(row.beforeArchive, "base64"))
  if (sha256Base64(bytes) !== row.beforeSha256)
    throw new RestoreError("The version before of this restore is damaged and cannot be opened.", "not_found")
  return {
    source: { kind: "version", id: row.id, instanceId: row.targetInstanceId, at: row.beforeTakenAt },
    ...(await unpack(ctx, bytes, privateKey)),
  }
}

async function unpack(ctx: Ctx, bytes: Uint8Array, privateKey: string) {
  let entries: Awaited<ReturnType<typeof openArchive>>
  try {
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
    manifest: manifestEntry ? (JSON.parse(entryText(manifestEntry)) as Manifest) : null,
    workflows: json<N8nWorkflow>("workflows/").filter((w) => w && typeof w.id === "string" && Array.isArray(w.nodes)),
    credentials: json<ArchivedCredential>("credentials/").filter((c) => c && typeof c.id === "string"),
  }
}

export type CredentialRef = { type: string; id: string | null; name: string | null; embedded: boolean }

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

const MAX_DEPTH = 10
export const TOO_DEEP = "embeds workflows more than 10 levels deep"

export function credentialRefs(nodes: N8nNode[], warnings: string[] = [], embedded = false, depth = 0) {
  const refs: CredentialRef[] = []
  for (const node of nodes ?? []) {
    for (const [type, ref] of Object.entries(node.credentials ?? {}))
      refs.push({ type, id: ref?.id ?? null, name: ref?.name ?? null, embedded })
    const source = embeddedSource(node)
    if (!source) continue
    if (depth >= MAX_DEPTH) {
      warnings.push(`"${node.name}" ${TOO_DEEP}; n8n-ops cannot check the credentials inside.`)
      continue
    }
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
    if (source && depth < MAX_DEPTH) {
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
  embedded: number
  warnings: string[]
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
const positionOf = (n: N8nNode) => (n as N8nNode & { position?: unknown }).position ?? null
const moved = (a: N8nNode[], b: N8nNode[]) => {
  const there = new Map((b ?? []).map((n) => [n.name, positionOf(n)]))
  return (a ?? []).some((n) => there.has(n.name) && !isDeepStrictEqual(positionOf(n), there.get(n.name)))
}

export function workflowChanges(archived: N8nWorkflow, live: N8nWorkflow): ChangeKind[] {
  const out: ChangeKind[] = []
  const has = (k: keyof N8nWorkflow) => k in live
  if (
    !isDeepStrictEqual(shape(archived.nodes), shape(live.nodes)) ||
    !isDeepStrictEqual(archived.connections ?? {}, live.connections ?? {}) ||
    (has("nodeGroups") && !isDeepStrictEqual(archived.nodeGroups ?? null, live.nodeGroups ?? null))
  )
    out.push("definition")
  if (moved(archived.nodes, live.nodes)) out.push("layout")
  if (has("settings") && !isDeepStrictEqual(archived.settings ?? {}, live.settings ?? {})) out.push("settings")
  if (archived.name !== live.name) out.push("name")
  if (has("description") && (archived.description ?? null) !== (live.description ?? null)) out.push("description")
  if (has("staticData") && !isDeepStrictEqual(archived.staticData ?? null, live.staticData ?? null))
    out.push("staticData")
  if (has("pinData") && !isDeepStrictEqual(archived.pinData ?? null, live.pinData ?? null)) out.push("pinData")
  if (Boolean(archived.active) !== Boolean(live.active)) out.push("published")
  if (Boolean(live.isArchived) !== Boolean(archived.isArchived)) out.push("archived")
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
      const warnings: string[] = []
      for (const ref of credentialRefs(w.nodes, warnings)) {
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
        warnings,
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
  if (!archive.source.instanceId) return { available: false, reason: "The instance of this archive was removed." }
  const [instance] = await ctx.db.select().from(instances).where(eq(instances.id, archive.source.instanceId))
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

export async function inspectArchive(ctx: Ctx, source: ArchiveSource, privateKey: string) {
  const archive = await loadArchive(ctx, source, privateKey)
  const { workflows, credentials } = summarize(archive)
  return {
    source: archive.source,
    manifest: archive.manifest,
    workflows,
    credentials,
    comparison: await compareWithInstance(ctx, archive),
  }
}

export async function archivedWorkflow(ctx: Ctx, source: ArchiveSource, privateKey: string, workflowId: string) {
  const archive = await loadArchive(ctx, source, privateKey)
  const workflow = archive.workflows.find((w) => w.id === workflowId)
  if (!workflow) throw new RestoreError("This workflow is not in the archive.", "not_found")
  return workflow
}

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
  live: N8nCredential[] | string
  targetName: string
  firstStep: number
}

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
      if (typeof live === "string") {
        actions.push({ ...base, action: "keep", reason: `Not checked: ${live}` })
        continue
      }
      if (!ref.id) {
        actions.push({
          ...base,
          action: "remove",
          reason: "The workflow names it without an ID, so it cannot be matched; set it in n8n.",
        })
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
          targetName: found.name,
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

export const REPLACE_MIN_VERSION = "2.35.0"
const AS_COPY = "Restore it as a copy instead."

export const isPublished = (w: Pick<N8nWorkflow, "active" | "activeVersionId">) =>
  "activeVersionId" in w && w.activeVersionId !== undefined ? Boolean(w.activeVersionId) : Boolean(w.active)

export function replaceRefusal(
  target: Pick<Instance, "name" | "version" | "scopes">,
  sameInstance: boolean,
): string | null {
  if (!sameInstance) return `Replace works only on the instance the archive is from. ${AS_COPY}`
  if (!target.version)
    return `The n8n version of ${target.name} is not known, and Replace needs n8n ${REPLACE_MIN_VERSION} or later. Check the instance, or restore it as a copy instead.`
  if (compareVersions(target.version, REPLACE_MIN_VERSION) < 0)
    return `${target.name} runs n8n ${target.version}. Replace needs n8n ${REPLACE_MIN_VERSION} or later, where a write can leave the published version alone. ${AS_COPY}`
  const missing = ["workflow:read", "workflow:update"].filter((s) => !effectiveScopes(target).includes(s))
  if (missing.length)
    return `The API key of ${target.name} cannot ${missing.length === 2 ? "read or update" : missing[0] === "workflow:read" ? "read" : "update"} workflows (${missing.join(", ")}). ${AS_COPY}`
  return null
}

export function liveRefusal(archived: N8nWorkflow, live: N8nWorkflow | null, targetName: string): string | null {
  if (!live) return `${archived.name} is not on ${targetName} any more, or its API key cannot see it. ${AS_COPY}`
  if (live.isArchived) return `${archived.name} is archived in n8n. ${AS_COPY} Or unarchive it in n8n first.`
  if (!archived.createdAt || !live.createdAt)
    return `n8n-ops cannot prove that the workflow in n8n is the one in the archive: ${archived.createdAt ? "n8n" : "the archive"} does not say when it was created. ${AS_COPY}`
  if (!sameTime(archived.createdAt, live.createdAt))
    return `The workflow with this ID in n8n was created at another time than the archived one, so it is another workflow. ${AS_COPY}`
  return null
}

export function credentialRefusal(actions: CredentialAction[]): string | null {
  const keep = actions.find((a) => a.action === "keep")
  if (keep && keep.action === "keep")
    return `n8n-ops cannot check the credentials the workflow uses (${keep.reason.replace(/^Not checked: /, "").replace(/\.$/, "")}), so it does not replace it. ${AS_COPY}`
  const removed = actions.filter((a) => a.action === "remove")
  if (removed.length)
    return `${removed.map((a) => `${a.name} (${a.action === "remove" ? a.reason.replace(/; set it in n8n\.$/, "") : ""})`).join(", ")}: the workflow would lose ${removed.length === 1 ? "this credential" : "these credentials"}, so it is not replaced. ${AS_COPY}`
  return null
}

function takenSettings(settings: Record<string, unknown> | undefined, fields: WorkflowFields | null) {
  const taken = { ...(settings ?? {}) }
  const dropped: string[] = []
  if (fields?.settings)
    for (const key of Object.keys(taken))
      if (!fields.settings.includes(key)) {
        delete taken[key]
        dropped.push(key)
      }
  return { taken, dropped }
}

export function replaceSettings(archived: N8nWorkflow, live: N8nWorkflow, fields: WorkflowFields | null) {
  const published = isPublished(live)
  const { taken, dropped } = takenSettings(published ? live.settings : archived.settings, fields)
  return {
    settingsFrom: (published ? "live" : "backup") as ReplacePlan["settingsFrom"],
    settings: taken,
    effective: { ...(live.settings ?? {}), ...taken },
    dropped,
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    )
  return value
}

const sha256 = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")

const optionalValue = (value: unknown) => (filled(value) ? value : null)

const CLEARED: Record<(typeof OPTIONAL_FIELDS)[number], unknown> = { nodeGroups: [], description: "", pinData: {} }

const byCredentialId = (nodes: N8nNode[]) =>
  nodes.map((n) =>
    n.credentials
      ? {
          ...n,
          credentials: Object.fromEntries(
            Object.entries(n.credentials).map(([type, ref]) => [type, ref?.id ? { id: ref.id } : ref]),
          ),
        }
      : n,
  )

export function definitionHash(w: Pick<N8nWorkflow, "nodes" | "connections"> & { name?: string }): string {
  const sorted = byCredentialId([...(w.nodes ?? [])]).sort((a, b) => a.name.localeCompare(b.name))
  return sha256({ name: w.name ?? null, nodes: sorted, connections: w.connections ?? {} })
}

export type ReplaceProof = { hash: string; fields: Record<string, string>; settings: Record<string, unknown> }

export function replaceProof(body: WorkflowBody, settings: Record<string, unknown>): ReplaceProof {
  const fields: Record<string, string> = {}
  for (const field of OPTIONAL_FIELDS) if (field in body) fields[field] = sha256(optionalValue(body[field]))
  return { hash: definitionHash(body), fields, settings }
}

export function settingsDifferences(expected: Record<string, unknown>, after: Record<string, unknown> | undefined) {
  const a = after ?? {}
  return Object.entries(expected).flatMap(([key, value]) =>
    !(key in a)
      ? [`settings.${key} is not set (n8n may use its default instead)`]
      : !isDeepStrictEqual(a[key], value)
        ? [`settings.${key} has another value`]
        : [],
  )
}

export function proofDifferences(proof: ReplaceProof, after: N8nWorkflow): string[] {
  const out: string[] = []
  if (definitionHash(after) !== proof.hash) out.push("the name, nodes or connections")
  for (const [field, hash] of Object.entries(proof.fields))
    if (field in after && sha256(optionalValue(after[field as keyof N8nWorkflow])) !== hash) out.push(field)
  out.push(...settingsDifferences(proof.settings, after.settings))
  return out
}

export const landed = (after: N8nWorkflow, proof: ReplaceProof) => proofDifferences(proof, after).length === 0

export function publishedChange(
  before: Pick<N8nWorkflow, "active" | "activeVersionId">,
  after: Pick<N8nWorkflow, "active" | "activeVersionId">,
): string | null {
  if (isPublished(before) && !isPublished(after))
    return "n8n unpublished this workflow while it was replaced, so it does not run now. Publish it again in n8n."
  if (!isPublished(before) && isPublished(after))
    return "n8n published this workflow while it was replaced, which n8n-ops never asks for. Check in n8n which version runs."
  if ((before.activeVersionId ?? null) !== (after.activeVersionId ?? null))
    return "n8n published another version of this workflow while it was replaced. Check in n8n which version runs."
  return null
}

export function replaceWarning(
  proof: ReplaceProof,
  before: Pick<N8nWorkflow, "active" | "activeVersionId">,
  after: N8nWorkflow,
): string | null {
  const out: string[] = []
  const published = publishedChange(before, after)
  if (published) out.push(published)
  const differs = proofDifferences(proof, after)
  if (differs.length)
    out.push(
      `n8n now holds something else than what was sent: ${differs.join("; ")}. Look at the workflow in n8n; it may have been saved there at the same moment.`,
    )
  return out.length ? out.join(" ") : null
}

async function liveWorkflow(client: N8nClient, id: string, targetName: string): Promise<N8nWorkflow | null> {
  try {
    return await client.getWorkflow(id)
  } catch (error) {
    if (error instanceof N8nError && error.status === 404) return null
    throw new RestoreError(`The workflow could not be read from ${targetName}: ${n8nMessage(error)}`)
  }
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

const filled = (value: unknown) =>
  value !== undefined &&
  value !== null &&
  value !== "" &&
  !(typeof value === "object" && Object.keys(value as object).length === 0)

async function replacePlan(
  ctx: Ctx,
  client: N8nClient,
  target: Target,
  workflow: N8nWorkflow,
  archived: Map<string, ArchivedCredential>,
  warnings: string[],
  code: string,
  date: string,
): Promise<Omit<RestorePlan, "earlierUnknown">> {
  const live = await liveWorkflow(client, workflow.id, target.name)
  const refusedLive = liveRefusal(workflow, live, target.name)
  if (refusedLive || !live) throw new RestoreError(refusedLive ?? AS_COPY)
  const refs = credentialRefs(workflow.nodes, warnings)
  if (warnings.some((w) => w.includes(TOO_DEEP)))
    throw new RestoreError(
      `${workflow.name} ${TOO_DEEP}; n8n-ops cannot check the credentials inside, so it is not restored.`,
    )
  const liveRefs = credentialRefs(live.nodes, [])
  let creds: N8nCredential[] | string = "the API key cannot list credentials (credential:list)."
  if ((refs.length > 0 || liveRefs.length > 0) && effectiveScopes(target).includes("credential:list")) {
    try {
      creds = await client.listCredentials()
    } catch (error) {
      creds = `the credentials could not be listed: ${n8nMessage(error)}`
    }
  }
  const { actions, nextStep } = resolveCredentials({
    refs,
    archived,
    sameInstance: true,
    live: creds,
    targetName: target.name,
    firstStep: 1,
  })
  const refusedCredentials = credentialRefusal(actions)
  if (refusedCredentials) throw new RestoreError(refusedCredentials)
  if (liveRefs.length > 0) {
    if (typeof creds === "string")
      warnings.push(`n8n-ops could not check the credentials the workflow uses now in n8n: ${creds}`)
    else {
      const gone = [
        ...new Set(liveRefs.filter((r) => !r.id || !creds.some((c) => c.id === r.id)).map((r) => r.name ?? r.id)),
      ]
      if (gone.length)
        warnings.push(
          `The workflow in n8n now uses credentials that do not exist there: ${gone.join(", ")}. Putting the version before back later would need them set in n8n by hand.`,
        )
    }
  }
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
  steps.push({ step: nextStep, kind: "workflow", action: "replace", sourceId: workflow.id, name: workflow.name })
  const fields = await workflowFieldsOf(ctx, target)
  const settings = replaceSettings(workflow, live, fields)
  const { body, notRestored } = copyBody({ ...workflow, settings: settings.settings }, workflow.name, fields)
  if (settings.settingsFrom === "live")
    notRestored.unshift(
      "settings: the workflow is published, so its current settings are sent unchanged and the archived ones are not restored (a change of settings makes n8n publish again)",
    )
  else for (const key of settings.dropped) notRestored.unshift(`settings.${key}: this n8n does not take it`)
  for (const field of OPTIONAL_FIELDS)
    if (!filled(workflow[field]) && filled(live[field])) {
      if (fields?.fields.includes(field)) Object.assign(body, { [field]: CLEARED[field] })
      else
        notRestored.push(
          `${field}: the archive has none, and this n8n does not say it takes the field, so the workflow keeps its current one`,
        )
    }
  if (filled(live.staticData)) notRestored.push("staticData: the workflow keeps its current polling state")
  const { ids, removed } = credentialChanges(actions)
  const sameAsLive =
    !actions.some((a) => a.action === "create") &&
    landed(
      live,
      replaceProof(
        {
          ...body,
          nodes: mapCredentialRefs(body.nodes, (ref) => (removed.has(refKey(ref)) ? null : ids.get(refKey(ref)))),
        },
        settings.effective,
      ),
    )
  if (sameAsLive)
    warnings.push(
      "The workflow in n8n already holds this version in everything n8n-ops compares (name, nodes, connections, settings and the fields sent). A replace writes it again as a new version, but nothing will look different.",
    )
  return {
    target: { id: target.id, name: target.name, sameInstance: true, revision: target.configRevision },
    item: { kind: "workflow", id: workflow.id, name: workflow.name },
    mode: "replace",
    date,
    credentials: actions,
    steps,
    notRestored: [...new Set(notRestored)],
    warnings,
    sent: { fields: Object.keys(body), settings: body.settings },
    replace: {
      workflowId: workflow.id,
      live: {
        name: live.name,
        updatedAt: live.updatedAt ?? null,
        versionId: live.versionId ?? null,
        activeVersionId: live.activeVersionId ?? null,
        published: isPublished(live),
      },
      settingsFrom: settings.settingsFrom,
      effectiveSettings: settings.effective,
      sameAsLive,
    },
  }
}

function credentialChanges(actions: CredentialAction[]) {
  const ids = new Map<string, { id: string; name: string }>()
  for (const a of actions)
    if (a.action === "link") ids.set(`id:${a.sourceId}`, { id: a.targetId, name: a.targetName ?? a.name })
  const removed = new Set(
    actions.filter((a) => a.action === "remove").map((a) => refKey({ type: a.type, id: a.sourceId, name: a.name })),
  )
  return { ids, removed }
}

function reviewedBody(
  workflow: N8nWorkflow,
  nodes: N8nNode[],
  name: string,
  sent: NonNullable<RestorePlan["sent"]>,
): WorkflowBody {
  const { body } = copyBody({ ...workflow, nodes, settings: sent.settings }, name, {
    fields: sent.fields,
    settings: Object.keys(sent.settings),
  })
  for (const field of OPTIONAL_FIELDS)
    if (sent.fields.includes(field) && !(field in body)) Object.assign(body, { [field]: CLEARED[field] })
  return body
}

async function buildPlan(
  ctx: Ctx,
  archive: OpenedArchive,
  target: Target,
  item: { kind: RestoreKind; id: string },
  mode: RestoreMode,
  code: string,
  date: string,
  restoreId: string | null,
): Promise<{ plan: RestorePlan; workflow?: N8nWorkflow; client: N8nClient }> {
  const client = clientFor(ctx, target)
  const sameInstance = archive.source.instanceId === target.id
  const archived = new Map(archive.credentials.map((c) => [c.id, c]))
  const warnings: string[] = []
  let plan: Omit<RestorePlan, "earlierUnknown">
  let workflow: N8nWorkflow | undefined
  if (mode === "replace") {
    if (item.kind !== "workflow") throw new RestoreError("Only a workflow can be replaced.")
    const refused = replaceRefusal(target, sameInstance)
    if (refused) throw new RestoreError(refused)
    workflow = archive.workflows.find((w) => w.id === item.id)
    if (!workflow) throw new RestoreError("This workflow is not in the archive.", "not_found")
    plan = await replacePlan(ctx, client, target, workflow, archived, warnings, code, date)
  } else if (item.kind === "credential") {
    const credential = archived.get(item.id)
    if (!credential) throw new RestoreError("This credential is not in the archive.", "not_found")
    if (!credential.data)
      throw new RestoreError(
        `The archive has no secrets for ${credential.name}; n8n cannot take a credential without them.`,
      )
    plan = {
      target: { id: target.id, name: target.name, sameInstance, revision: target.configRevision },
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
    if (warnings.some((w) => w.includes(TOO_DEEP)))
      throw new RestoreError(
        `${workflow.name} ${TOO_DEEP}; n8n-ops cannot check the credentials inside, so it is not restored.`,
      )
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
    const { body, notRestored } = copyBody(workflow, name, await workflowFieldsOf(ctx, target))
    plan = {
      target: { id: target.id, name: target.name, sameInstance, revision: target.configRevision },
      item: { kind: "workflow", id: workflow.id, name: workflow.name },
      mode: "copy",
      date,
      credentials: actions,
      steps,
      notRestored,
      warnings,
      sent: { fields: Object.keys(body), settings: body.settings },
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

export type RestoreActor = { actor: string; actorId: string | null; via: AuditVia }

export async function previewRestore(
  ctx: Ctx,
  input: {
    source: ArchiveSource
    privateKey: string
    targetInstanceId: string
    kind: RestoreKind
    itemId: string
    mode?: RestoreMode
  } & RestoreActor,
) {
  const mode = input.mode ?? "copy"
  const target = await targetFor(ctx, input.targetInstanceId)
  const archive = await loadArchive(ctx, input.source, input.privateKey)
  const date = new Date().toISOString().slice(0, 10)
  const code = randomBytes(4).toString("hex")
  const item = { kind: input.kind, id: input.itemId }
  const { plan } = await buildPlan(ctx, archive, target, item, mode, code, date, null)
  const [row] = await ctx.db
    .insert(restores)
    .values({
      code,
      actor: input.actor,
      actorId: input.actorId,
      via: input.via,
      runId: archive.source.kind === "run" ? archive.source.id : null,
      fromRestoreId: archive.source.kind === "version" ? archive.source.id : null,
      targetInstanceId: target.id,
      kind: input.kind,
      itemId: input.itemId,
      itemName: plan.item.name,
      mode,
      status: "previewed",
      reviewed: plan,
    })
    .returning()
  return view(row as Row)
}

type Row = typeof restores.$inferSelect

export function view(row: Omit<Row, "beforeArchive">) {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    kind: row.kind,
    itemId: row.itemId,
    itemName: row.itemName,
    mode: row.mode,
    runId: row.runId,
    fromRestoreId: row.fromRestoreId,
    targetInstanceId: row.targetInstanceId,
    actor: row.actor,
    plan: row.reviewed,
    steps: row.steps,
    error: row.error,
    versionBefore: row.beforeSha256 && row.beforeTakenAt ? { takenAt: row.beforeTakenAt } : null,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
    finishedAt: row.finishedAt,
    expiresAt: row.status === "previewed" ? new Date(row.createdAt.getTime() + REVIEW_TTL_MS) : null,
  }
}

type Ended = Exclude<RestoreStatus, "previewed" | "pending">
const actions: Record<Ended, Record<RestoreKind, string>> = {
  done: { workflow: "Workflow restored", credential: "Credential restored" },
  failed: { workflow: "Workflow restore failed", credential: "Credential restore failed" },
  unknown: { workflow: "Workflow restore unknown", credential: "Credential restore unknown" },
}
const replaceActions: Record<Ended, string> = {
  done: "Workflow replaced",
  failed: "Workflow replace failed",
  unknown: "Workflow replace unknown",
}

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
        action: row.mode === "replace" ? replaceActions[status] : actions[status][row.kind],
        target: `${row.itemName} ${row.mode === "replace" ? "on" : "into"} ${row.reviewed.target.name}`,
        via: row.via as AuditVia,
        details: {
          restoreId: row.id,
          runId: row.runId,
          ...(row.fromRestoreId ? { fromRestoreId: row.fromRestoreId } : {}),
          mode: row.mode,
          steps: steps.map(({ step, kind, action, name, status: s, createdId, error: e, warning }) => ({
            step,
            kind,
            ...(action ? { action } : {}),
            name,
            status: s,
            createdId,
            error: e,
            ...(warning ? { warning } : {}),
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
    } catch {}
    return error.message
  }
  return (error as Error)?.message ?? String(error)
}

export function stepMessage(step: Pick<PlannedStep, "kind">, error: unknown) {
  if (step.kind !== "credential") return n8nMessage(error)
  if (error instanceof N8nError) return `n8n answered ${error.status}.`
  return (error as Error)?.name === "TimeoutError" ? "n8n did not answer in time." : "The connection to n8n failed."
}

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

async function runStep(
  client: N8nClient,
  step: PlannedStep,
  write: () => Promise<{ id: string }>,
): Promise<RestoreStep> {
  try {
    const created = await write()
    return { ...step, status: "done", createdId: created.id }
  } catch (error) {
    const message = stepMessage(step, error)
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

async function sealVersionBefore(ctx: Ctx, live: N8nWorkflow, targetName: string, privateKey: string) {
  const { backupRecipient } = await ctx.settings.get("keys")
  const manifest: Manifest = {
    format: 1,
    instance: targetName,
    createdAt: new Date().toISOString(),
    includesSecrets: false,
    workflows: 1,
    credentials: 0,
    source: "api",
  }
  const entries = [
    textEntry("manifest.json", JSON.stringify(manifest)),
    textEntry(`workflows/${live.id}.json`, JSON.stringify(live)),
  ]
  const unpacked = createTar(entries).length
  const max = await maxArchiveBytes(ctx)
  if (unpacked > max)
    throw new RestoreError(
      `The workflow is too large to keep as the version before (${mib(unpacked)}; an archive may hold at most ${mib(max)}), so it was not replaced. Raise Largest archive in the backup settings, or restore it as a copy instead.`,
    )
  const recipients = [...(backupRecipient ? [backupRecipient] : []), await identityToRecipient(privateKey.trim())]
  return sealArchive(entries, [...new Set(recipients)])
}

const mib = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MiB`

async function runReplace(
  ctx: Ctx,
  row: Row,
  steps: RestoreStep[],
  i: number,
  client: N8nClient,
  reviewed: ReplacePlan,
  body: WorkflowBody,
  privateKey: string,
): Promise<RestoreStep> {
  const step = steps[i] as RestoreStep
  const id = reviewed.workflowId
  let before: N8nWorkflow
  try {
    before = await client.getWorkflow(id)
  } catch (error) {
    return {
      ...step,
      status: "failed",
      error: `The workflow could not be read right before writing it, so nothing was written: ${n8nMessage(error)}`,
    }
  }
  if (
    (before.updatedAt ?? null) !== reviewed.live.updatedAt ||
    (before.versionId ?? null) !== reviewed.live.versionId ||
    (before.activeVersionId ?? null) !== reviewed.live.activeVersionId ||
    isPublished(before) !== reviewed.live.published
  )
    return {
      ...step,
      status: "failed",
      error: "The workflow changed in n8n since you reviewed this restore, so it was not replaced. Review it again.",
    }
  const proof = replaceProof(body, reviewed.effectiveSettings)
  const sentHash = proof.hash
  const sentFields = proof.fields
  try {
    const sealed = await sealVersionBefore(ctx, before, row.reviewed.target.name, privateKey)
    steps[i] = { ...step, sentHash, sentFields }
    await ctx.db
      .update(restores)
      .set({
        steps,
        beforeArchive: Buffer.from(sealed.bytes).toString("base64"),
        beforeSha256: sealed.sha256Base64,
        beforeTakenAt: new Date(),
      })
      .where(eq(restores.id, row.id))
  } catch (error) {
    return {
      ...step,
      status: "failed",
      error:
        error instanceof RestoreError
          ? error.message
          : `The version before could not be kept, so the workflow was not replaced: ${(error as Error).message}`,
    }
  }
  const current = { ...step, sentHash, sentFields }
  try {
    await client.updateWorkflow(id, body, { publishIfActive: false })
  } catch (error) {
    const message = n8nMessage(error)
    let after: N8nWorkflow | null = null
    try {
      after = await client.getWorkflow(id)
    } catch {
      after = null
    }
    const published = after ? publishedChange(before, after) : null
    const said = published ? { warning: published } : {}
    if (after && provenWritten(after, proof, before.versionId, reviewed.sameAsLive)) {
      const warning = replaceWarning(proof, before, after)
      return {
        ...current,
        status: "done",
        createdId: id,
        error: `n8n answered with an error but saved it: ${message}`,
        ...(warning ? { warning } : {}),
      }
    }
    if (
      after &&
      error instanceof N8nError &&
      (after.updatedAt ?? null) === (before.updatedAt ?? null) &&
      (after.versionId ?? null) === (before.versionId ?? null)
    )
      return { ...current, status: "failed", error: message, ...said }
    return { ...current, status: "unknown", error: message, ...said }
  }
  let after: N8nWorkflow
  try {
    after = await client.getWorkflow(id)
  } catch (error) {
    return {
      ...current,
      status: "done",
      createdId: id,
      warning: `Replaced, but n8n could not be read afterwards to check it: ${n8nMessage(error)}. Look at the workflow in n8n.`,
    }
  }
  const warning = replaceWarning(proof, before, after)
  return { ...current, status: "done", createdId: id, ...(warning ? { warning } : {}) }
}

function provenWritten(
  after: N8nWorkflow,
  proof: ReplaceProof,
  versionBefore: string | null | undefined,
  sameAsLive: boolean | undefined,
) {
  return landed(after, proof) && (!sameAsLive || (after.versionId ?? null) !== (versionBefore ?? null))
}

export function confirmRestore(ctx: Ctx, restoreId: string, privateKey: string, by: RestoreActor) {
  return oneAtATime(`restore:${restoreId}`, () => confirmNow(ctx, restoreId, privateKey, by))
}

async function confirmNow(ctx: Ctx, restoreId: string, privateKey: string, by: RestoreActor) {
  const [row] = await ctx.db
    .update(restores)
    .set({ status: "pending", confirmedAt: new Date(), actor: by.actor, actorId: by.actorId, via: by.via })
    .where(and(eq(restores.id, restoreId), eq(restores.status, "previewed")))
    .returning()
  if (!row) {
    const [current] = await ctx.db.select().from(restores).where(eq(restores.id, restoreId))
    if (!current) throw new RestoreError("This review has expired. Open the archive again.", "not_found")
    return view(current)
  }
  if (row.createdAt.getTime() + REVIEW_TTL_MS < Date.now())
    return view(await finish(ctx, row, "failed", [], "The review expired before it was confirmed. Review it again."))
  const steps: RestoreStep[] = row.reviewed.steps.map((s) => ({ ...s, status: "todo" }))
  try {
    return await execute(ctx, row, steps, privateKey)
  } catch (error) {
    const at = steps.findIndex((s) => s.status === "todo")
    if (at >= 0) steps[at] = { ...(steps[at] as RestoreStep), status: "unknown" }
    return view(await finish(ctx, row, "unknown", steps, `The restore stopped: ${(error as Error).message}`))
  }
}

async function execute(ctx: Ctx, row: Row, steps: RestoreStep[], privateKey: string) {
  await ctx.db.update(restores).set({ steps }).where(eq(restores.id, row.id))
  let built: Awaited<ReturnType<typeof buildPlan>>
  let archive: OpenedArchive
  let target: Target
  try {
    const source: ArchiveSource | null = row.runId
      ? { runId: row.runId }
      : row.fromRestoreId
        ? { versionOf: row.fromRestoreId }
        : null
    if (!source) throw new RestoreError("The archive of this review is gone.")
    if (!row.targetInstanceId) throw new RestoreError("The target instance was removed.")
    target = await targetFor(ctx, row.targetInstanceId)
    archive = await loadArchive(ctx, source, privateKey)
    built = await buildPlan(
      ctx,
      archive,
      target,
      { kind: row.kind, id: row.itemId },
      row.mode,
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
  const { ids, removed } = credentialChanges(plan.credentials)
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
      const sent = plan.sent ?? { fields: ["name", "nodes", "connections", "settings"], settings: {} }
      const body = reviewedBody(workflow as N8nWorkflow, nodes, step.name, sent)
      result =
        step.action === "replace" && plan.replace
          ? await runReplace(ctx, row, steps, i, client, plan.replace, body, privateKey)
          : await runStep(client, step, () => client.createWorkflow(body))
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

export function checkRestore(ctx: Ctx, restoreId: string) {
  return oneAtATime(`restore:${restoreId}`, () => checkNow(ctx, restoreId))
}

async function checkNow(ctx: Ctx, restoreId: string) {
  const [row] = await ctx.db.select().from(restores).where(eq(restores.id, restoreId))
  if (!row) throw new RestoreError("Restore not found.", "not_found")
  if (row.status !== "unknown") return view(row)
  const [target] = row.targetInstanceId
    ? await ctx.db.select().from(instances).where(eq(instances.id, row.targetInstanceId))
    : []
  if (!target) throw new RestoreError("The target instance was removed.", "not_found")
  const client = clientFor(ctx, target)
  const steps = [...row.steps]
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as RestoreStep
    if (step.status === "done") continue
    if (step.action === "replace") {
      steps[i] = await checkReplace(client, step, row.reviewed.replace)
      continue
    }
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
  const [saved] = await ctx.db
    .update(restores)
    .set({ steps })
    .where(and(eq(restores.id, row.id), eq(restores.status, "unknown")))
    .returning()
  return view(saved ?? row)
}

async function checkReplace(client: N8nClient, step: RestoreStep, reviewed: ReplacePlan | undefined) {
  if (step.status !== "unknown") return step
  if (!step.sentHash)
    return { ...step, error: "It stopped before the workflow was sent, so n8n-ops has nothing to compare." }
  let live: N8nWorkflow
  try {
    live = await client.getWorkflow(step.sourceId)
  } catch {
    return { ...step, error: "Could not be checked now." }
  }
  const seen = reviewed && {
    active: reviewed.live.published,
    activeVersionId: reviewed.live.activeVersionId ?? undefined,
  }
  const published = seen ? publishedChange(seen, live) : null
  const said = published ? { warning: published } : {}
  const proof: ReplaceProof = {
    hash: step.sentHash,
    fields: step.sentFields ?? {},
    settings: reviewed?.effectiveSettings ?? {},
  }
  if (!reviewed || !provenWritten(live, proof, reviewed.live.versionId, reviewed.sameAsLive))
    return { ...step, error: "n8n does not hold what was sent, which does not prove it failed.", ...said }
  const { error: _e, ...rest } = step
  return { ...rest, status: "done" as const, createdId: step.sourceId, ...said }
}

export async function getRestore(ctx: Ctx, restoreId: string) {
  const [row] = await ctx.db.select().from(restores).where(eq(restores.id, restoreId))
  return row ? view(row) : null
}

export async function recentRestores(ctx: Ctx, targetInstanceId: string, limit = 20) {
  const { beforeArchive: _stored, ...columns } = getTableColumns(restores)
  const rows = await ctx.db
    .select(columns)
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

const UPDATE_OVERLAP_MS = 5 * 60_000

export async function sweepRestores(ctx: Ctx) {
  await ctx.db
    .delete(restores)
    .where(and(eq(restores.status, "previewed"), lt(restores.createdAt, new Date(Date.now() - REVIEW_TTL_MS))))
  if (process.uptime() * 1000 < UPDATE_OVERLAP_MS) return
  const pending = await ctx.db
    .select({ id: restores.id })
    .from(restores)
    .where(and(eq(restores.status, "pending"), lt(restores.confirmedAt, new Date(Date.now() - UPDATE_OVERLAP_MS))))
  for (const { id } of pending) {
    await oneAtATime(`restore:${id}`, async () => {
      const [row] = await ctx.db.select().from(restores).where(eq(restores.id, id))
      if (row?.status !== "pending") return
      const steps: RestoreStep[] = row.steps.length
        ? [...row.steps]
        : row.reviewed.steps.map((s) => ({ ...s, status: "todo" }))
      const at = steps.findIndex((s) => s.status === "todo")
      if (at >= 0) steps[at] = { ...(steps[at] as RestoreStep), status: "unknown" }
      await finish(ctx, row, "unknown", steps, "This restore was cut off. Check n8n before trying again.")
    })
  }
}

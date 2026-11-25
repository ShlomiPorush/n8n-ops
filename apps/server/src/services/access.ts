import { type AccessChannel, accessChannels } from "@n8n-ops/shared"
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm"
import { type Ctx, changed } from "../context.ts"
import {
  type AccessDropReason,
  type AccessStatus,
  accessCalls,
  accessRequestInstances,
  accessRequests,
  apiTokens,
  instances,
  oauthStore,
  workflows,
} from "../db/schema.ts"
import { tokenActor } from "../http/types.ts"
import type { AuditVia } from "../lib/audit.ts"
import { newToken, sha256 } from "../lib/crypto.ts"
import {
  operationToForward,
  parseSpec,
  parseWorkflowFields,
  type SpecOperation,
  specHasScopes,
  type WorkflowFields,
} from "../lib/n8n-spec.ts"
import { type FetchLike, N8nClient } from "../n8n/client.ts"
import { availableChannels, channelsFor } from "./access-channels.ts"
import { can, effectiveScopes, type Instance, unsupportedVersion } from "./instances.ts"
import { retrying } from "./problems.ts"

export class AccessError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const MAX_PENDING_PER_TOKEN = 3
const KEY_PREFIX = "nops_n8n"
const MAX_WORKFLOWS = 200
const MAX_WORKFLOW_ID = 200
export const MAX_ENDED_LISTED = 200

type Db = Ctx["db"]
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Db | Tx

export type AccessInstanceRow = typeof accessRequestInstances.$inferSelect

export function policyScopes(instance: Pick<Instance, "agentAccess" | "scopes">) {
  if (!instance.agentAccess.enabled) return []
  const held = new Set(effectiveScopes(instance))
  return instance.agentAccess.scopes.filter((s) => held.has(s))
}

type AccessFields = Pick<
  Instance,
  "agentAccess" | "scopes" | "setupState" | "chosenCapabilities" | "apiKeyEnc" | "scopesCheckedAt" | "version"
>

export const openToAgents = (instance: AccessFields) =>
  can(instance, "agents") && Boolean(instance.apiKeyEnc) && !unsupportedVersion(instance)

export function grantableScopes(instance: AccessFields) {
  return openToAgents(instance) ? policyScopes(instance) : []
}

const isUuid = (ref: string) => /^[0-9a-f-]{36}$/i.test(ref)

async function findInstances(ctx: Ctx, refs: string[]) {
  const ids = refs.filter(isUuid)
  const rows = await ctx.db
    .select()
    .from(instances)
    .where(ids.length ? or(inArray(instances.name, refs), inArray(instances.id, ids)) : inArray(instances.name, refs))
  return (ref: string) => rows.find((r) => r.name === ref) ?? rows.find((r) => r.id === ref.toLowerCase()) ?? null
}

const timedOut = (e: unknown) => {
  const code = (e as { code?: string } | null)?.code ?? (e as { cause?: { code?: string } } | null)?.cause?.code
  return code === "57014" || code === "55P03"
}

const specs = new Map<
  string,
  {
    baseUrl: string
    version: string | null
    ops: SpecOperation[]
    workflowFields: WorkflowFields | null
    at: number
  }
>()

async function loadSpec(ctx: Ctx, instance: Instance, fetchImpl: typeof fetch) {
  const cached = specs.get(instance.id)
  if (
    cached &&
    cached.baseUrl === instance.baseUrl &&
    cached.version === instance.version &&
    Date.now() - cached.at < 6 * 3600_000
  )
    return cached
  const res = await fetchImpl(`${instance.baseUrl.replace(/\/+$/, "")}/api/v1/openapi.yml`, {
    signal: AbortSignal.timeout(20_000),
    redirect: "manual",
  })
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined)
    throw new AccessError(
      "spec_unavailable",
      `n8n answered ${res.status} for its API description: the instance's address redirects, and n8n-ops does not follow redirects. Set the address n8n answers at.`,
    )
  }
  if (!res.ok) throw new AccessError("spec_unavailable", `n8n did not return its API description (HTTP ${res.status}).`)
  const text = await res.text()
  const ops = parseSpec(text)
  if (!specHasScopes(ops))
    throw new AccessError(
      "spec_without_scopes",
      "This n8n version does not describe API key scopes; it needs 2.14 or later.",
    )
  let workflowFields: WorkflowFields | null = null
  try {
    workflowFields = parseWorkflowFields(text)
  } catch {}
  const entry = { baseUrl: instance.baseUrl, version: instance.version, ops, workflowFields, at: Date.now() }
  specs.set(instance.id, entry)
  ctx.log.info("n8n API description loaded", { instance: instance.name, operations: ops.length })
  return entry
}

export async function instanceSpec(ctx: Ctx, instance: Instance, fetchImpl: typeof fetch = fetch) {
  return (await loadSpec(ctx, instance, fetchImpl)).ops
}

export async function instanceWorkflowFields(ctx: Ctx, instance: Instance, fetchImpl: typeof fetch = fetch) {
  return (await loadSpec(ctx, instance, fetchImpl)).workflowFields
}

export type AccessInstanceInput = { instance: string; scopes: string[]; workflowIds?: string[] }

export type AccessRequestInput = {
  reason: string
  minutes: number
  instances: AccessInstanceInput[]
  notify?: AccessChannel[]
}

const NAMES_WITHIN_MS = 5_000
const NAMES_AT_ONCE = 5
export const REQUEST_WITHIN_MS = 10_000
const SPECS_WITHIN_MS = 7_000
const SPECS_AT_ONCE = 5

export async function workflowNamesOf(
  ctx: Ctx,
  instance: Instance,
  ids: string[],
  { fetchImpl = fetch as FetchLike, withinMs = NAMES_WITHIN_MS } = {},
): Promise<Record<string, string>> {
  const names = new Map<string, string>()
  if (!ids.length) return {}
  const mapped = await ctx.db
    .select({ id: workflows.workflowId, name: workflows.name })
    .from(workflows)
    .where(and(eq(workflows.instanceId, instance.id), inArray(workflows.workflowId, ids)))
  for (const w of mapped) names.set(w.id, w.name)
  if (withinMs > 0 && instance.apiKeyEnc && effectiveScopes(instance).includes("workflow:read")) {
    const deadline = AbortSignal.timeout(withinMs)
    const timed: FetchLike = (url, init) =>
      fetchImpl(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline })
    const client = new N8nClient(instance.baseUrl, ctx.secrets.decrypt(instance.apiKeyEnc), timed, withinMs)
    const queue = ids.filter((id) => id && id !== "." && id !== "..")
    const next = async (): Promise<void> => {
      const id = queue.shift()
      if (id === undefined || deadline.aborted) return
      const name = await client.getWorkflow(id).then(
        (w) => w?.name,
        () => undefined,
      )
      if (typeof name === "string" && name) names.set(id, name)
      return next()
    }
    await Promise.all(Array.from({ length: NAMES_AT_ONCE }, next))
  }
  return Object.fromEntries(names)
}

export const nameIn = (names: Record<string, string> | undefined, id: string) =>
  names && Object.hasOwn(names, id) && typeof names[id] === "string" ? names[id] : undefined

async function eachAtMost<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  const queue = [...items]
  const next = async (): Promise<void> => {
    const item = queue.shift()
    if (item === undefined) return
    await work(item)
    return next()
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next))
}

const requesting = new Set<string>()

export async function requestAccess(ctx: Ctx, tokenId: string, input: AccessRequestInput) {
  if (requesting.has(tokenId))
    throw new AccessError(
      "request_in_progress",
      "Another access request of this agent is still being made. Wait for its answer, then ask again.",
    )
  requesting.add(tokenId)
  try {
    return await requestAccessNow(ctx, tokenId, input)
  } finally {
    requesting.delete(tokenId)
  }
}

const notAllowed = () =>
  new AccessError(
    "not_allowed",
    "This agent may not request access to n8n instances. Ask a person to allow it in n8n-ops.",
  )

async function requestAccessNow(ctx: Ctx, tokenId: string, input: AccessRequestInput, fetchImpl = fetch) {
  const started = Date.now()
  const [token] = await ctx.db.select().from(apiTokens).where(eq(apiTokens.id, tokenId))
  if (!token?.canRequestAccess || token.revokedAt) throw notAllowed()
  if (!input.instances.length) throw new AccessError("no_instances", "Ask for at least one instance.")

  const asked: { instance: Instance; scopes: string[]; workflowIds: string[] }[] = []
  const find = await findInstances(
    ctx,
    input.instances.map((i) => i.instance),
  )
  for (const item of input.instances) {
    const instance = find(item.instance)
    if (!instance) throw new AccessError("unknown_instance", `There is no instance named "${item.instance}".`)
    if (asked.some((a) => a.instance.id === instance.id))
      throw new AccessError("duplicate_instance", `${instance.name} is named more than once; name each instance once.`)
    if (!instance.agentAccess.enabled || !openToAgents(instance))
      throw new AccessError("instance_closed", `Agents may not request access to ${instance.name}.`)
    const grantable = grantableScopes(instance)
    const scopes = [...new Set(item.scopes)]
    const extra = scopes.filter((s) => !grantable.includes(s))
    if (!scopes.length || extra.length)
      throw new AccessError(
        "scopes_not_grantable",
        `${extra.length ? `Not grantable on ${instance.name}: ${extra.join(", ")}. ` : `Ask for at least one scope on ${instance.name}. `}Grantable: ${grantable.join(", ") || "none"}.`,
      )
    asked.push({ instance, scopes, workflowIds: [...new Set(item.workflowIds ?? [])] })
  }
  const { maxMinutes, pendingMinutes, defaultNotify } = await ctx.settings.get("access")
  if (input.minutes < 1 || input.minutes > maxMinutes)
    throw new AccessError("too_long", `Ask for 1 to ${maxMinutes} minutes.`)

  const specsBy = AbortSignal.timeout(SPECS_WITHIN_MS)
  const timed: typeof fetch = (url, init) =>
    fetchImpl(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, specsBy]) : specsBy })
  const failed: AccessError[] = []
  await eachAtMost(asked, SPECS_AT_ONCE, async ({ instance }) => {
    if (failed.length) return
    try {
      await instanceSpec(ctx, instance, timed)
    } catch (e) {
      failed.push(
        e instanceof AccessError
          ? new AccessError(e.code, `${instance.name}: ${e.message}`)
          : new AccessError("spec_unavailable", `${instance.name} did not return its API description in time.`),
      )
    }
  })
  if (failed[0]) throw failed[0]

  const notifyChoice = input.notify?.length ? accessChannels.filter((c) => input.notify?.includes(c)) : null
  const notify = channelsFor(notifyChoice, defaultNotify, await availableChannels(ctx))

  const namesWithin = Math.min(NAMES_WITHIN_MS, REQUEST_WITHIN_MS - 1_000 - (Date.now() - started))
  const named = await Promise.all(
    asked.map((a) => workflowNamesOf(ctx, a.instance, a.workflowIds, { withinMs: Math.max(0, namesWithin) })),
  )

  const deadline = started + REQUEST_WITHIN_MS - 500
  const busy = () =>
    new AccessError("busy", "n8n-ops could not store the request in time; nothing was stored. Ask again.")
  const row = await ctx.db
    .transaction(async (tx) => {
      const within = async () => {
        const left = Math.floor(deadline - Date.now())
        if (left < 50) throw busy()
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${left}`))
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${left}`))
      }
      await within()
      const [held] = await tx.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).for("update")
      if (!held?.canRequestAccess || held.revokedAt) throw notAllowed()
      await within()
      const [pending] = await tx
        .select({ n: count() })
        .from(accessRequests)
        .where(
          and(
            eq(accessRequests.tokenId, tokenId),
            or(
              eq(accessRequests.status, "pending"),
              and(
                eq(accessRequests.status, "released"),
                isNull(accessRequests.decidedAt),
                gt(accessRequests.decideBy, new Date()),
              ),
            ),
          ),
        )
      if ((pending?.n ?? 0) >= MAX_PENDING_PER_TOKEN)
        throw new AccessError(
          "too_many_pending",
          "This agent has reached its limit of access requests waiting for a decision; a request it released before a decision counts until it would have expired. Wait for a decision, or ask again later.",
        )
      await within()
      const [created] = await tx
        .insert(accessRequests)
        .values({
          tokenId,
          reason: input.reason,
          requestedMinutes: input.minutes,
          minutes: input.minutes,
          decideBy: new Date(Date.now() + pendingMinutes * 60_000),
          notifyChoice,
        })
        .returning()
      if (!created) throw new Error("the request was not stored")
      await within()
      await tx.insert(accessRequestInstances).values(
        asked.map((a, position) => ({
          requestId: created.id,
          instanceId: a.instance.id,
          instanceName: a.instance.name,
          position,
          requestedScopes: a.scopes,
          requestedWorkflowIds: a.workflowIds,
          scopes: a.scopes,
          workflowIds: a.workflowIds,
          workflowNames: named[position] ?? {},
        })),
      )
      await within()
      await ctx.audit(
        {
          actor: tokenActor(held),
          action: "Instance access requested",
          target: namesTarget(asked.map((a) => a.instance.name)),
          via: "agent",
          details: {
            requestId: created.id,
            minutes: input.minutes,
            reason: input.reason,
            instances: asked.map((a) => ({ name: a.instance.name, scopes: a.scopes, workflowIds: a.workflowIds })),
          },
        },
        tx,
      )
      if (Date.now() > deadline) throw busy()
      return created
    })
    .catch((e) => {
      throw timedOut(e) ? busy() : e
    })
  changed(ctx, "access", "overview")
  ctx.events.emit("access-requested", row.id)
  return {
    id: row.id,
    status: row.status,
    ...(asked.length === 1 ? { instance: asked[0]?.instance.name } : {}),
    instances: asked.map((a) => a.instance.name),
    decideBy: row.decideBy,
    notify,
  }
}

const namesTarget = (names: string[]) => {
  const text = names.join(", ")
  return text.length <= 200 ? text : `${names[0]} and ${names.length - 1} more instances`
}

export async function instancesOf(db: Reader, ids: string[]): Promise<Map<string, AccessInstanceRow[]>> {
  const by = new Map<string, AccessInstanceRow[]>()
  if (!ids.length) return by
  const rows = await db
    .select()
    .from(accessRequestInstances)
    .where(inArray(accessRequestInstances.requestId, ids))
    .orderBy(asc(accessRequestInstances.requestId), asc(accessRequestInstances.position))
  for (const r of rows) by.set(r.requestId, [...(by.get(r.requestId) ?? []), r])
  return by
}

export const isGranted = (r: Pick<AccessInstanceRow, "included" | "droppedReason">) => r.included && !r.droppedReason

const sameSet = (a: string[] | null, b: string[]) =>
  a !== null && a.length === b.length && new Set([...a, ...b]).size === a.length

export function differsFromAsked(
  r: Pick<typeof accessRequests.$inferSelect, "minutes" | "requestedMinutes">,
  list: AccessInstanceRow[],
) {
  if (r.minutes !== r.requestedMinutes) return true
  return list.some(
    (i) =>
      i.requestedScopes === null ||
      !isGranted(i) ||
      i.droppedScopes.length > 0 ||
      !sameSet(i.requestedScopes, i.scopes) ||
      !sameSet(i.requestedWorkflowIds, i.workflowIds),
  )
}

type Decider = { by: string; via: AuditVia }

const messageOutdated = { telegramClosedAt: null }

export type ApprovalInstance = {
  instanceId: string
  included: boolean
  scopes: string[]
  allWorkflows: boolean
  workflowIds: string[]
}

export type ApprovalEdit = { minutes: number; instances: ApprovalInstance[] }

type Target = {
  existing?: AccessInstanceRow
  instanceId: string | null
  instanceName: string
  included: boolean
  scopes: string[]
  workflowIds: string[]
}

function checkEdit(edit: ApprovalEdit) {
  const seen = new Set<string>()
  for (const i of edit.instances) {
    if (seen.has(i.instanceId)) throw new AccessError("duplicate_instance", "An instance is named more than once.")
    seen.add(i.instanceId)
    if (!i.included) continue
    if (!i.allWorkflows && !i.workflowIds.length)
      throw new AccessError(
        "no_workflows",
        "Choose at least one workflow, or the whole instance, for every instance you grant.",
      )
    if (i.workflowIds.length > MAX_WORKFLOWS)
      throw new AccessError("too_many_workflows", `Name at most ${MAX_WORKFLOWS} workflows on one instance.`)
    if (i.workflowIds.some((w) => !w.trim() || w.length > MAX_WORKFLOW_ID))
      throw new AccessError("invalid_workflow", "A workflow ID is empty or too long.")
  }
}

export async function approveAccess(
  ctx: Ctx,
  id: string,
  who: Decider,
  { revision, edit }: { revision: number; edit?: ApprovalEdit },
) {
  if (edit) checkEdit(edit)
  const { maxMinutes } = await ctx.settings.get("access")
  const minutesWanted = edit?.minutes
  if (minutesWanted !== undefined && (minutesWanted < 1 || minutesWanted > maxMinutes))
    throw new AccessError("too_long", `Grant 1 to ${maxMinutes} minutes.`)

  const before = await instancesOf(ctx.db, [id])
  const extraNames = new Map<string, Record<string, string>>()
  if (edit) {
    await Promise.all(
      edit.instances
        .filter((i) => i.included && !i.allWorkflows)
        .map(async (i) => {
          const known = before.get(id)?.find((c) => c.instanceId === i.instanceId)?.workflowNames ?? {}
          const unknown = [...new Set(i.workflowIds)].filter((w) => nameIn(known, w) === undefined)
          if (!unknown.length) return
          const [instance] = await ctx.db.select().from(instances).where(eq(instances.id, i.instanceId))
          if (instance) extraNames.set(i.instanceId, await workflowNamesOf(ctx, instance, unknown))
        }),
    )
  }

  const key = newToken(KEY_PREFIX)
  const updated = await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(accessRequests).where(eq(accessRequests.id, id)).for("update")
    if (!row) throw new AccessError("not_found", "There is no such request.")
    if (row.status !== "pending") throw new AccessError("already_decided", `The request is already ${row.status}.`)
    if (row.decideBy < new Date()) throw new AccessError("already_decided", "The request expired before a decision.")
    if (row.revision !== revision)
      throw new AccessError(
        "request_changed",
        "The request was changed since you looked at it. Look at it again, then decide.",
      )
    const children = (await instancesOf(tx, [id])).get(id) ?? []

    const targets: Target[] = edit
      ? edit.instances.map((i) => {
          const was = before.get(id)?.find((c) => c.instanceId === i.instanceId)
          const existing = children.find((c) => c.instanceId === i.instanceId || (was !== undefined && c.id === was.id))
          return {
            existing,
            instanceId: i.instanceId,
            instanceName: existing?.instanceName ?? "",
            included: i.included,
            scopes: [...new Set(i.scopes)],
            workflowIds: i.allWorkflows ? [] : [...new Set(i.workflowIds.map((w) => w.trim()))],
          }
        })
      : children.map((c) => ({
          existing: c,
          instanceId: c.instanceId,
          instanceName: c.instanceName,
          included: c.included,
          scopes: c.scopes,
          workflowIds: c.workflowIds,
        }))
    if (edit)
      for (const c of children)
        if (!targets.some((t) => t.existing === c))
          targets.push({
            existing: c,
            instanceId: c.instanceId,
            instanceName: c.instanceName,
            included: c.instanceId === null && c.included,
            scopes: c.scopes,
            workflowIds: c.workflowIds,
          })

    const ids = [...new Set(targets.filter((t) => t.included && t.instanceId).map((t) => t.instanceId as string))]
    // Without this order, two approvals that share instances can deadlock.
    const locked = ids.length
      ? await tx.select().from(instances).where(inArray(instances.id, ids)).orderBy(asc(instances.id)).for("update")
      : []
    const byId = new Map(locked.map((i) => [i.id, i]))

    const kept = targets.filter((t) => t.existing || !t.included || (t.instanceId && byId.has(t.instanceId)))
    const decided = kept.map((t) => {
      const instance =
        t.existing && !t.existing.instanceId ? undefined : t.instanceId ? byId.get(t.instanceId) : undefined
      if (!t.included) return { ...t, instance, droppedReason: null, droppedScopes: [] as string[] }
      if (t.existing && !t.existing.instanceId)
        return { ...t, instance, droppedReason: "deleted" as AccessDropReason, droppedScopes: [] }
      if (!instance) return { ...t, instance, droppedReason: "deleted" as AccessDropReason, droppedScopes: [] }
      if (!instance.agentAccess.enabled || !openToAgents(instance))
        return { ...t, instance, droppedReason: "closed" as AccessDropReason, droppedScopes: [] }
      const grantable = grantableScopes(instance)
      const allowed = t.scopes.filter((s) => grantable.includes(s))
      const droppedScopes = t.scopes.filter((s) => !grantable.includes(s))
      if (!allowed.length)
        return { ...t, instance, droppedReason: "no_scopes" as AccessDropReason, droppedScopes, scopes: t.scopes }
      return { ...t, instance, scopes: allowed, droppedReason: null, droppedScopes }
    })
    const granted = decided.filter((d) => d.included && !d.droppedReason)
    if (!granted.length)
      throw new AccessError(
        "nothing_to_approve",
        decided.some((d) => d.droppedReason)
          ? "None of the instances can be granted any more: they were closed to agents, deleted, or allow none of the scopes. Deny the request."
          : "Include at least one instance to approve.",
      )

    const minutes = minutesWanted ?? row.minutes
    if (minutes < 1 || minutes > maxMinutes)
      throw new AccessError("too_long", `Grant 1 to ${maxMinutes} minutes; change the duration first.`)
    const now = new Date()
    const [approved] = await tx
      .update(accessRequests)
      .set({
        status: "approved",
        minutes,
        decidedAt: now,
        decidedBy: who.by,
        decidedVia: who.via,
        expiresAt: new Date(now.getTime() + minutes * 60_000),
        keyPrefix: key.slice(0, KEY_PREFIX.length + 5),
        keyHash: sha256(key),
        keyEnc: ctx.secrets.encrypt(key),
        ...messageOutdated,
      })
      .where(and(eq(accessRequests.id, id), eq(accessRequests.status, "pending")))
      .returning()
    if (!approved) throw new AccessError("already_decided", "The request was decided meanwhile.")

    let position = Math.max(-1, ...children.map((c) => c.position))
    for (const d of decided) {
      const added = d.instanceId ? extraNames.get(d.instanceId) : undefined
      const ids = [...new Set([...d.workflowIds, ...(d.existing?.requestedWorkflowIds ?? [])])]
      const workflowNames = Object.fromEntries(
        ids.flatMap((w) => {
          const name = nameIn(d.existing?.workflowNames, w) ?? nameIn(added, w)
          return name === undefined ? [] : [[w, name]]
        }),
      )
      const values = {
        included: d.included,
        scopes: d.scopes,
        workflowIds: d.workflowIds,
        workflowNames,
        droppedReason: d.droppedReason,
        droppedScopes: d.droppedScopes,
      }
      if (d.existing)
        await tx.update(accessRequestInstances).set(values).where(eq(accessRequestInstances.id, d.existing.id))
      else if (d.instance && d.included) {
        position += 1
        await tx.insert(accessRequestInstances).values({
          requestId: id,
          instanceId: d.instance.id,
          instanceName: d.instance.name,
          position,
          ...values,
        })
      }
    }

    const list = (pick: (c: AccessInstanceRow) => { scopes: string[] | null; workflowIds: string[] | null }) =>
      children.filter((c) => c.requestedScopes !== null).map((c) => ({ name: c.instanceName, ...pick(c) }))
    await auditDecision(ctx, tx, id, "Instance access approved", who, {
      requested: {
        minutes: row.requestedMinutes,
        instances: list((c) => ({ scopes: c.requestedScopes, workflowIds: c.requestedWorkflowIds })),
      },
      granted: {
        minutes,
        instances: granted.map((g) => ({
          name: g.instance?.name ?? g.instanceName,
          scopes: g.scopes,
          workflowIds: g.workflowIds,
        })),
      },
      left: decided
        .filter((d) => d.droppedReason || d.droppedScopes.length)
        .map((d) => ({
          name: d.instance?.name ?? d.instanceName,
          reason: d.droppedReason,
          scopes: d.droppedScopes,
        })),
    })
    return approved
  })
  changed(ctx, "access", "overview")
  return updated
}

export type DraftChange = { position: number; included: boolean } | { minutes: number }

export async function editDraft(ctx: Ctx, id: string, revision: number, change: DraftChange) {
  const { maxMinutes } = await ctx.settings.get("access")
  if ("minutes" in change && (change.minutes < 1 || change.minutes > maxMinutes))
    throw new AccessError("too_long", `Grant 1 to ${maxMinutes} minutes.`)
  const edited = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(accessRequests)
      .set({
        revision: sql`${accessRequests.revision} + 1`,
        ...("minutes" in change ? { minutes: change.minutes } : {}),
      })
      .where(
        and(
          eq(accessRequests.id, id),
          eq(accessRequests.status, "pending"),
          eq(accessRequests.revision, revision),
          gt(accessRequests.decideBy, new Date()),
        ),
      )
      .returning()
    if (!row) throw new AccessError("request_changed", "The request changed meanwhile; check the message again.")
    if ("position" in change) {
      const [child] = await tx
        .update(accessRequestInstances)
        .set({ included: change.included })
        .where(and(eq(accessRequestInstances.requestId, id), eq(accessRequestInstances.position, change.position)))
        .returning({ id: accessRequestInstances.id })
      if (!child) throw new AccessError("not_found", "The request has no such instance.")
    }
    return row
  })
  changed(ctx, "access", "overview")
  return edited
}

export async function denyAccess(ctx: Ctx, id: string, who: Decider) {
  const updated = await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(accessRequests).where(eq(accessRequests.id, id)).for("update")
    if (!row) throw new AccessError("not_found", "There is no such request.")
    if (row.status !== "pending") throw new AccessError("already_decided", `The request is already ${row.status}.`)
    if (row.decideBy < new Date()) throw new AccessError("already_decided", "The request expired before a decision.")
    const [denied] = await tx
      .update(accessRequests)
      .set({ status: "denied", decidedAt: new Date(), decidedBy: who.by, decidedVia: who.via, ...messageOutdated })
      .where(and(eq(accessRequests.id, id), eq(accessRequests.status, "pending")))
      .returning()
    if (!denied) throw new AccessError("already_decided", "The request was decided meanwhile.")
    await auditDecision(ctx, tx, id, "Instance access denied", who)
    return denied
  })
  changed(ctx, "access", "overview")
  return updated
}

export async function revokeAccess(ctx: Ctx, id: string, who: Decider) {
  const updated = await ctx.db.transaction(async (tx) => {
    const row = await revokeIn(ctx, tx, id, who)
    if (!row) throw new AccessError("not_active", "The request is not pending or active.")
    return row
  })
  changed(ctx, "access", "overview")
  return updated
}

async function revokeIn(ctx: Ctx, tx: Tx, id: string, who: Decider) {
  const [row] = await tx
    .update(accessRequests)
    .set({ status: "revoked", endedAt: new Date(), keyEnc: null, ...messageOutdated })
    .where(and(eq(accessRequests.id, id), inArray(accessRequests.status, ["pending", "approved"])))
    .returning()
  if (row) await auditDecision(ctx, tx, id, "Instance access revoked", who)
  return row ?? null
}

export async function revokeAccessOfToken(ctx: Ctx, tokenId: string, who: Decider, tx: Tx) {
  const rows = await tx
    .select({ id: accessRequests.id })
    .from(accessRequests)
    .where(and(eq(accessRequests.tokenId, tokenId), inArray(accessRequests.status, ["pending", "approved"])))
  for (const r of rows) await revokeIn(ctx, tx, r.id, who)
  return rows.length
}

async function auditDecision(
  ctx: Ctx,
  tx: Tx,
  id: string,
  action: string,
  who: Decider,
  details: Record<string, unknown> = {},
) {
  const [row] = await tx
    .select({ token: apiTokens.name, tokenId: apiTokens.id })
    .from(accessRequests)
    .innerJoin(apiTokens, eq(accessRequests.tokenId, apiTokens.id))
    .where(eq(accessRequests.id, id))
  const names = ((await instancesOf(tx, [id])).get(id) ?? []).map((c) => c.instanceName)
  await ctx.audit(
    {
      actor: who.by,
      action,
      target: `${names.length ? namesTarget(names) : "?"} for ${row ? tokenActor({ id: row.tokenId, name: row.token }) : "token:?"}`,
      via: who.via,
      details: { requestId: id, ...details },
    },
    tx,
  )
}

const proxyBase = (publicUrl: string, instanceName: string) =>
  `${publicUrl.replace(/\/+$/, "")}/n8n/${encodeURIComponent(instanceName)}/api/v1`

export async function collectAccess(ctx: Ctx, tokenId: string, id: string, publicUrl: string) {
  const [r] = await ctx.db
    .select()
    .from(accessRequests)
    .where(and(eq(accessRequests.id, id), eq(accessRequests.tokenId, tokenId)))
  if (!r) throw new AccessError("not_found", "This agent has no such access request.")
  const children = (await instancesOf(ctx.db, [id])).get(id) ?? []
  const current = await currentNames(
    ctx.db,
    children.flatMap((c) => (c.instanceId ? [c.instanceId] : [])),
  )
  const nameOf = (c: AccessInstanceRow) => (c.instanceId ? current.get(c.instanceId) : undefined) ?? c.instanceName
  const status: AccessStatus = r.status === "pending" && r.decideBy < new Date() ? "expired" : r.status
  const decided = r.decidedAt !== null && status !== "denied"
  const shown = decided
    ? children.filter((c) => isGranted(c) && c.instanceId)
    : children.filter((c) => c.requestedScopes !== null)
  const primary = shown.find((c) => c.requestedScopes !== null) ?? shown[0]
  const scopesOf = (c: AccessInstanceRow) => (decided ? c.scopes : (c.requestedScopes ?? c.scopes))
  const workflowsOf = (c: AccessInstanceRow) => (decided ? c.workflowIds : (c.requestedWorkflowIds ?? c.workflowIds))
  const base = {
    id: r.id,
    status,
    instance: primary ? nameOf(primary) : null,
    scopes: primary ? scopesOf(primary) : [],
    workflowIds: primary ? workflowsOf(primary) : [],
    minutes: decided ? r.minutes : r.requestedMinutes,
    requestedAt: r.requestedAt,
    decidedBy: r.decidedBy,
    expiresAt: r.expiresAt,
    ...(decided ? { changed: differsFromAsked(r, children) } : {}),
    notifiedVia: accessChannels.filter((c) => (c === "telegram" ? r.telegramMessageId : r.emailSentAt) !== null),
  }
  const list = shown.map((c) => ({
    instance: nameOf(c),
    scopes: scopesOf(c),
    workflowIds: workflowsOf(c),
    ...(status === "approved" ? { baseUrl: proxyBase(publicUrl, nameOf(c)) } : {}),
  }))
  if (status !== "approved") return { ...base, instances: list }
  const usage = {
    instances: list,
    baseUrl: primary ? proxyBase(publicUrl, nameOf(primary)) : null,
    header: "X-N8N-API-KEY",
  }
  if (!r.keyEnc) return { ...base, ...usage, keyPrefix: r.keyPrefix, note: "The key was already collected." }
  const [taken] = await ctx.db
    .update(accessRequests)
    .set({ keyEnc: null, keyCollectedAt: new Date() })
    .where(and(eq(accessRequests.id, r.id), eq(accessRequests.keyEnc, r.keyEnc)))
    .returning({ id: accessRequests.id })
  if (!taken) return { ...base, ...usage, keyPrefix: r.keyPrefix, note: "The key was already collected." }
  return { ...base, ...usage, key: ctx.secrets.decrypt(r.keyEnc) }
}

async function currentNames(db: Reader, ids: string[]) {
  if (!ids.length) return new Map<string, string>()
  const rows = await db
    .select({ id: instances.id, name: instances.name })
    .from(instances)
    .where(inArray(instances.id, [...new Set(ids)]))
  return new Map(rows.map((r) => [r.id, r.name]))
}

export const SUMMARY_MAX = 1000

export function cleanSummary(summary: string | undefined): string | null {
  const chars = [...(summary ?? "").replaceAll("\u0000", "").trim()]
  if (!chars.length) return null
  if (chars.length <= SUMMARY_MAX) return chars.join("")
  return `${chars
    .slice(0, SUMMARY_MAX - 1)
    .join("")
    .trimEnd()}…`
}

export async function releaseAccess(ctx: Ctx, tokenId: string, id: string, summary?: string) {
  const [owner] = await ctx.db
    .select({ id: apiTokens.id, name: apiTokens.name })
    .from(accessRequests)
    .innerJoin(apiTokens, eq(accessRequests.tokenId, apiTokens.id))
    .where(and(eq(accessRequests.id, id), eq(accessRequests.tokenId, tokenId)))
  if (!owner) throw new AccessError("not_found", "This agent has no such access request.")
  const updated = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(accessRequests)
      .set({
        status: "released",
        endedAt: new Date(),
        keyEnc: null,
        summary: cleanSummary(summary),
        ...messageOutdated,
      })
      .where(
        and(
          eq(accessRequests.id, id),
          eq(accessRequests.tokenId, tokenId),
          inArray(accessRequests.status, ["pending", "approved"]),
        ),
      )
      .returning()
    if (!row) throw new AccessError("not_active", "The request is not pending or active.")
    await auditDecision(ctx, tx, id, "Instance access released", { by: tokenActor(owner), via: "agent" })
    return row
  })
  changed(ctx, "access", "overview")
  return { id, status: updated.status }
}

export async function expireAccess(ctx: Ctx) {
  const now = new Date()
  const ended = await ctx.db
    .update(accessRequests)
    .set({ status: "expired", endedAt: now, keyEnc: null, ...messageOutdated })
    .where(
      or(
        and(eq(accessRequests.status, "pending"), lt(accessRequests.decideBy, now)),
        and(eq(accessRequests.status, "approved"), lt(accessRequests.expiresAt, now)),
      ),
    )
    .returning({ id: accessRequests.id })
  if (ended.length) changed(ctx, "access", "overview")
  return { expired: ended.length }
}

export async function grantForKey(ctx: Ctx, key: string, ref: string) {
  if (!key.startsWith(`${KEY_PREFIX}_`)) return null
  const rows = await ctx.db
    .select({
      r: accessRequests,
      tokenRevokedAt: apiTokens.revokedAt,
      tokenKind: apiTokens.kind,
      agentGrant: oauthStore.id,
      grant: accessRequestInstances,
      instance: instances,
    })
    .from(accessRequests)
    .innerJoin(apiTokens, eq(accessRequests.tokenId, apiTokens.id))
    .leftJoin(oauthStore, and(eq(oauthStore.type, "Grant"), eq(oauthStore.id, apiTokens.grantId)))
    .leftJoin(
      accessRequestInstances,
      and(
        eq(accessRequestInstances.requestId, accessRequests.id),
        eq(accessRequestInstances.included, true),
        sql`${accessRequestInstances.droppedReason} is null`,
      ),
    )
    .leftJoin(
      instances,
      and(
        eq(accessRequestInstances.instanceId, instances.id),
        isUuid(ref) ? or(eq(instances.id, ref), eq(instances.name, ref)) : eq(instances.name, ref),
      ),
    )
    .where(eq(accessRequests.keyHash, sha256(key)))
  const row = rows[0]
  if (row?.r.status !== "approved" || row.tokenRevokedAt) return null
  if (!row.r.expiresAt || row.r.expiresAt < new Date()) return null
  if (row.tokenKind === "agent" && !row.agentGrant) return null
  const matches = rows.flatMap((m) => (m.grant && m.instance ? [{ grant: m.grant, instance: m.instance }] : []))
  const found = matches.find((m) => m.instance.name === ref) ?? matches.find((m) => m.instance.id === ref.toLowerCase())
  return { request: row.r, grant: found?.grant ?? null, instance: found?.instance ?? null }
}

export type Decision = { allowed: true } | { allowed: false; reason: string }

const CREDENTIAL_OPERATIONS = new Set([
  "/credentials",
  "/credentials/{}",
  "/credentials/{}/test",
  "/credentials/{}/transfer",
  "/credentials/schema/{}",
])

function idAfter(match: { op: SpecOperation; params: Record<string, string> }, resource: string) {
  const [, first, second] = match.op.template.split("/")
  const name = first === resource ? second?.match(/^\{(.+)\}$/)?.[1] : undefined
  return name === undefined ? undefined : match.params[name]
}

export const MAX_QUERY_PARAMETERS = 100

type Forward = { allowed: true; path: string; query: string; workflowFilter?: boolean; executionId?: string }

export function checkCall(
  ops: SpecOperation[],
  grant: { scopes: string[]; workflowIds: string[] },
  method: string,
  path: string,
  query: URLSearchParams,
): Forward | { allowed: false; reason: string } {
  const match = operationToForward(ops, method, path)
  if (!match) return { allowed: false, reason: `${method} ${path} is not an n8n public API operation.` }
  const missing = match.op.scopes.filter((s) => !grant.scopes.includes(s))
  if (missing.length)
    return { allowed: false, reason: `Needs ${missing.join(", ")}, which this access does not include.` }

  const names = [...query.keys()]
  if (names.length > MAX_QUERY_PARAMETERS)
    return { allowed: false, reason: `A call may have at most ${MAX_QUERY_PARAMETERS} query parameters.` }
  if (new Set(names).size !== names.length) return { allowed: false, reason: "Give each query parameter once." }
  if (names.some((name) => /[[\]]/.test(name)))
    return { allowed: false, reason: "Query parameter names cannot contain [ or ]." }
  const sent = new URLSearchParams(query)
  const template = match.op.template.replace(/\{[^}]*\}/g, "{}")

  if (template === "/workflows/{}" && match.op.method === "PUT" && !grant.scopes.includes("workflow:activate")) {
    if (!match.op.query.includes("publishIfActive"))
      return {
        allowed: false,
        reason:
          "On this n8n version, updating a published workflow publishes it, which needs workflow:activate, which this access does not include.",
      }
    const asked = sent.get("publishIfActive")
    if (asked !== null && asked !== "false")
      return {
        allowed: false,
        reason:
          "Publishing needs workflow:activate, which this access does not include. Leave out publishIfActive to save the update as a draft.",
      }
    sent.set("publishIfActive", "false")
  }
  const allow = (extra: { workflowFilter?: boolean; executionId?: string } = {}): Forward => ({
    allowed: true,
    path: match.path,
    query: sent.toString(),
    ...extra,
  })

  if (!grant.workflowIds.length) return allow()
  const beyond: Decision = {
    allowed: false,
    reason: `${method} ${match.op.template} is not limited to the workflows of this access; it needs access to the whole instance.`,
  }
  const allowed = new Set(grant.workflowIds)
  const workflowId = idAfter(match, "workflows")
  if (workflowId !== undefined) {
    if (template === "/workflows/{}/dependencies") return beyond
    return allowed.has(workflowId)
      ? allow()
      : { allowed: false, reason: `Workflow ${workflowId} is outside this access.` }
  }
  if (template === "/workflows" && method === "GET") return allow({ workflowFilter: true })
  if (template === "/workflows" && method === "POST")
    return { allowed: false, reason: "This access is limited to its workflows; it cannot create new ones." }
  if (template === "/executions" && method === "GET") {
    const w = sent.get("workflowId")
    return w && allowed.has(w)
      ? allow()
      : { allowed: false, reason: "Pass workflowId with one of the workflows of this access." }
  }
  const executionId = idAfter(match, "executions")
  if (executionId !== undefined) return allow({ executionId })
  if (template.startsWith("/executions"))
    return { allowed: false, reason: "This operation spans executions of other workflows." }
  if (CREDENTIAL_OPERATIONS.has(template)) return allow()
  return beyond
}

export const MAX_CHANGES = 1000
export const MAX_OTHER_CALLS = 500
export const MAX_CALL_PATH = 1024
export const MAX_CALL_REASON = 500
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
export const isChange = (method: string) => !READ_METHODS.has(method)

export function cutText(text: string, max: number) {
  if (text.length <= max) return text
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`
}

type CallTarget = { instanceId: string | null; method: string; path: string }

function callRow(requestId: string, call: CallTarget & { status: number | null; refused?: string }) {
  return {
    requestId,
    instanceId: call.instanceId
      ? sql`(select ${instances.id} from ${instances} where ${instances.id} = ${call.instanceId} for key share)`
      : null,
    method: call.method,
    path: cutText(call.path, MAX_CALL_PATH),
    status: call.status,
    refused: call.refused === undefined ? null : cutText(call.refused, MAX_CALL_REASON),
  }
}

async function countCalls(tx: Tx, requestId: string, by: { calls: number; refused: number }) {
  await tx
    .update(accessRequests)
    .set({
      callCount: sql`${accessRequests.callCount} + ${by.calls}`,
      refusedCount: sql`${accessRequests.refusedCount} + ${by.refused}`,
      telegramClosedAt: sql`CASE WHEN ${accessRequests.status} IN ('released', 'expired', 'revoked') THEN NULL ELSE ${accessRequests.telegramClosedAt} END`,
    })
    .where(eq(accessRequests.id, requestId))
}

async function trimOtherCalls(tx: Tx, requestId: string) {
  await tx.execute(sql`
    DELETE FROM ${accessCalls} WHERE ${accessCalls.id} IN (
      SELECT ${accessCalls.id} FROM ${accessCalls}
      WHERE ${accessCalls.requestId} = ${requestId} AND NOT ${accessCalls.change}
      ORDER BY ${accessCalls.at} DESC, ${accessCalls.id} DESC
      OFFSET ${MAX_OTHER_CALLS}
    )`)
}

export async function logCall(ctx: Ctx, requestId: string, call: CallTarget & { status: number; refused?: string }) {
  await retrying(() =>
    ctx.db.transaction(async (tx) => {
      await tx.insert(accessCalls).values(callRow(requestId, call))
      await countCalls(tx, requestId, { calls: 1, refused: call.refused === undefined ? 0 : 1 })
      await trimOtherCalls(tx, requestId)
    }),
  )
  changed(ctx, "access")
}

export async function reserveChange(ctx: Ctx, requestId: string, call: CallTarget): Promise<string | null> {
  const id = await ctx.db.transaction(async (tx) => {
    await tx
      .select({ id: accessRequests.id })
      .from(accessRequests)
      .where(eq(accessRequests.id, requestId))
      .for("update")
    const [made] = await tx
      .select({ n: count() })
      .from(accessCalls)
      .where(and(eq(accessCalls.requestId, requestId), eq(accessCalls.change, true)))
    if ((made?.n ?? 0) >= MAX_CHANGES) return null
    const [row] = await tx
      .insert(accessCalls)
      .values(callRow(requestId, { ...call, status: null }))
      .returning({ id: accessCalls.id })
    await countCalls(tx, requestId, { calls: 1, refused: 0 })
    return row?.id ?? null
  })
  if (id) changed(ctx, "access")
  return id
}

export async function refuseChange(ctx: Ctx, requestId: string, id: string, status: number, reason: string) {
  await retrying(() =>
    ctx.db.transaction(async (tx) => {
      await countCalls(tx, requestId, { calls: 0, refused: 1 })
      await tx
        .update(accessCalls)
        .set({ status, refused: cutText(reason, MAX_CALL_REASON) })
        .where(and(eq(accessCalls.id, id), eq(accessCalls.requestId, requestId)))
      await trimOtherCalls(tx, requestId)
    }),
  )
  changed(ctx, "access")
}

export async function finishChange(ctx: Ctx, id: string, status: number) {
  await ctx.db.update(accessCalls).set({ status }).where(eq(accessCalls.id, id))
  changed(ctx, "access")
}

function publicInstance(c: AccessInstanceRow, current: Map<string, string>) {
  return {
    position: c.position,
    instanceId: c.instanceId,
    name: (c.instanceId ? current.get(c.instanceId) : undefined) ?? c.instanceName,
    deleted: c.instanceId === null,
    requested: c.requestedScopes !== null,
    requestedScopes: c.requestedScopes,
    requestedWorkflowIds: c.requestedWorkflowIds,
    scopes: c.scopes,
    workflowIds: c.workflowIds,
    workflowNames: c.workflowNames,
    included: c.included,
    droppedReason: c.droppedReason,
    droppedScopes: c.droppedScopes,
  }
}

export async function listAccess(ctx: Ctx) {
  const live = ["pending", "approved"] as const
  const newest = [desc(accessRequests.requestedAt), desc(accessRequests.id)]
  const ended = ctx.db
    .select({ id: accessRequests.id })
    .from(accessRequests)
    .where(notInArray(accessRequests.status, [...live]))
    .orderBy(...newest)
    .limit(MAX_ENDED_LISTED)
  const rows = await ctx.db
    .select({ r: accessRequests, tokenName: apiTokens.name })
    .from(accessRequests)
    .innerJoin(apiTokens, eq(accessRequests.tokenId, apiTokens.id))
    .where(or(inArray(accessRequests.status, [...live]), inArray(accessRequests.id, ended)))
    .orderBy(...newest)
  return listed(ctx, rows)
}

export async function listEndedAccess(ctx: Ctx, before?: string) {
  const live = ["pending", "approved"] as const
  const rows = await ctx.db
    .select({ r: accessRequests, tokenName: apiTokens.name })
    .from(accessRequests)
    .innerJoin(apiTokens, eq(accessRequests.tokenId, apiTokens.id))
    .where(
      and(
        notInArray(accessRequests.status, [...live]),
        before
          ? sql`(${accessRequests.requestedAt}, ${accessRequests.id}) < ${ctx.db
              .select({ at: accessRequests.requestedAt, id: accessRequests.id })
              .from(accessRequests)
              .where(eq(accessRequests.id, before))}`
          : undefined,
      ),
    )
    .orderBy(desc(accessRequests.requestedAt), desc(accessRequests.id))
    .limit(MAX_ENDED_LISTED + 1)
  const page = rows.slice(0, MAX_ENDED_LISTED)
  return {
    requests: await listed(ctx, page),
    next: rows.length > MAX_ENDED_LISTED ? (page.at(-1)?.r.id ?? null) : null,
  }
}

async function listed(ctx: Ctx, rows: { r: typeof accessRequests.$inferSelect; tokenName: string }[]) {
  const children = await instancesOf(
    ctx.db,
    rows.map((x) => x.r.id),
  )
  const current = await currentNames(
    ctx.db,
    [...children.values()].flat().flatMap((c) => (c.instanceId ? [c.instanceId] : [])),
  )
  return rows.map(({ r, tokenName }) => {
    const list = (children.get(r.id) ?? []).map((c) => publicInstance(c, current))
    return {
      ...publicFields(r),
      instances: list,
      changed: differsFromAsked(r, children.get(r.id) ?? []),
      token: tokenName,
    }
  })
}

export async function getAccess(ctx: Ctx, id: string) {
  const read = await ctx.db.transaction(
    async (tx) => {
      const [row] = await tx
        .select({ r: accessRequests, tokenName: apiTokens.name })
        .from(accessRequests)
        .innerJoin(apiTokens, eq(accessRequests.tokenId, apiTokens.id))
        .where(eq(accessRequests.id, id))
      if (!row) return null
      const children = (await instancesOf(tx, [id])).get(id) ?? []
      const newest = [desc(accessCalls.at), desc(accessCalls.id)]
      const others = tx
        .select({ id: accessCalls.id })
        .from(accessCalls)
        .where(and(eq(accessCalls.requestId, id), eq(accessCalls.change, false)))
        .orderBy(...newest)
        .limit(MAX_OTHER_CALLS)
      const calls = await tx
        .select()
        .from(accessCalls)
        .where(and(eq(accessCalls.requestId, id), or(eq(accessCalls.change, true), inArray(accessCalls.id, others))))
        .orderBy(...newest)
      return { row, children, calls }
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  )
  if (!read) return null
  const { row, children, calls } = read
  const current = await currentNames(
    ctx.db,
    children.flatMap((c) => (c.instanceId ? [c.instanceId] : [])),
  )
  const list = await Promise.all(
    children.map(async (c) => {
      const shown = publicInstance(c, current)
      const ids = [...new Set([...c.workflowIds, ...(c.requestedWorkflowIds ?? [])])]
      const unnamed = ids.filter((w) => nameIn(c.workflowNames, w) === undefined)
      const mapped =
        unnamed.length && c.instanceId
          ? await ctx.db
              .select({ id: workflows.workflowId, name: workflows.name })
              .from(workflows)
              .where(and(eq(workflows.instanceId, c.instanceId), inArray(workflows.workflowId, unnamed)))
          : []
      const fromMap = new Map(mapped.map((w) => [w.id, w.name]))
      const workflowNames = Object.fromEntries(
        ids.flatMap((w) => {
          const name = nameIn(c.workflowNames, w) ?? fromMap.get(w)
          return name === undefined ? [] : [[w, name]]
        }),
      )
      return { ...shown, workflowNames }
    }),
  )
  const pending = row.r.status === "pending" && row.r.decideBy > new Date()
  const editor = pending ? await editorChoices(ctx, list) : undefined
  const callNames = new Map(list.flatMap((c) => (c.instanceId ? [[c.instanceId, c.name]] : [])))
  return {
    ...publicFields(row.r),
    instances: list,
    changed: differsFromAsked(row.r, children),
    token: row.tokenName,
    calls: calls.map((c) => ({ ...c, instance: c.instanceId ? (callNames.get(c.instanceId) ?? null) : null })),
    ...(editor ? { editor } : {}),
  }
}

async function editorChoices(ctx: Ctx, list: { instanceId: string | null }[]) {
  const all = await ctx.db.select().from(instances).orderBy(asc(instances.name))
  const open = all.filter((i) => i.agentAccess.enabled && openToAgents(i))
  const onRequest = new Set(list.flatMap((c) => (c.instanceId ? [c.instanceId] : [])))
  const grantable = Object.fromEntries(
    all.filter((i) => onRequest.has(i.id)).map((i) => [i.id, i.agentAccess.enabled ? grantableScopes(i) : []]),
  )
  return {
    grantable,
    others: open
      .filter((i) => !onRequest.has(i.id))
      .map((i) => ({ instanceId: i.id, name: i.name, scopes: grantableScopes(i) })),
  }
}

function publicFields(r: typeof accessRequests.$inferSelect) {
  const { keyHash: _h, keyEnc: _e, ...rest } = r
  return { ...rest, keyCollected: Boolean(r.keyCollectedAt) }
}

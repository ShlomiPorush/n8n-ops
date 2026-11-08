import { and, asc, count, desc, eq, gt, inArray, isNotNull, lt, or, sql } from "drizzle-orm"
import { type Ctx, changed } from "../context.ts"
import {
  type AccessDropReason,
  type AccessStatus,
  accessCalls,
  accessRequestInstances,
  accessRequests,
  apiTokens,
  instances,
  workflows,
} from "../db/schema.ts"
import { tokenActor } from "../http/types.ts"
import type { AuditVia } from "../lib/audit.ts"
import { newToken, sha256 } from "../lib/crypto.ts"
import {
  matchOperation,
  parseSpec,
  parseWorkflowFields,
  type SpecOperation,
  specHasScopes,
  type WorkflowFields,
} from "../lib/n8n-spec.ts"
import { type FetchLike, N8nClient } from "../n8n/client.ts"
import { can, effectiveScopes, type Instance, unsupportedVersion } from "./instances.ts"

/**
 * Temporary access for agents to n8n instances. An agent asks for one or more instances, each with scopes and
 * optional workflows, and a duration with a reason; a person approves (as asked, or after changing it) or denies; an
 * approved request gets one key the agent collects once and uses against the n8n-ops proxy
 * (/n8n/<instance>/api/v1/...) of every granted instance, which checks every call and forwards it with the
 * instance's own key. The key stops working when the time is up, when the agent releases it, or on revoke.
 */

export class AccessError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** At most this many open (pending) requests per token, so a looping agent cannot flood the approvers. */
const MAX_PENDING_PER_TOKEN = 3
const KEY_PREFIX = "nops_n8n"
/** The most workflows an approver may name on one instance, and the longest workflow ID taken. */
const MAX_WORKFLOWS = 200
const MAX_WORKFLOW_ID = 200

type Db = Ctx["db"]
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Db | Tx

export type AccessInstanceRow = typeof accessRequestInstances.$inferSelect

/** Scopes the instance's policy allows that its API key holds, whether or not Temporary access is chosen. */
export function policyScopes(instance: Pick<Instance, "agentAccess" | "scopes">) {
  if (!instance.agentAccess.enabled) return []
  const held = new Set(effectiveScopes(instance))
  return instance.agentAccess.scopes.filter((s) => held.has(s))
}

type AccessFields = Pick<
  Instance,
  "agentAccess" | "scopes" | "setupState" | "chosenCapabilities" | "apiKeyEnc" | "scopesCheckedAt" | "version"
>

/** Whether agents may use the instance's API now: active, chosen for Temporary access, with a key, n8n 2.14.0+. */
export const openToAgents = (instance: AccessFields) =>
  can(instance, "agents") && Boolean(instance.apiKeyEnc) && !unsupportedVersion(instance)

/** Scopes an agent may be granted on an instance: open to agents, allowed by its policy and held by its key. */
export function grantableScopes(instance: AccessFields) {
  return openToAgents(instance) ? policyScopes(instance) : []
}

const isUuid = (ref: string) => /^[0-9a-f-]{36}$/i.test(ref)

/** The instances an agent names, by name or ID, read at once; a ref without an instance is missing from the map. */
async function findInstances(ctx: Ctx, refs: string[]) {
  const ids = refs.filter(isUuid)
  const rows = await ctx.db
    .select()
    .from(instances)
    .where(ids.length ? or(inArray(instances.name, refs), inArray(instances.id, ids)) : inArray(instances.name, refs))
  // The name first, as the proxy does: agents name instances as the instance list does, and a name may look like an ID.
  return (ref: string) => rows.find((r) => r.name === ref) ?? rows.find((r) => r.id === ref.toLowerCase()) ?? null
}

/** PostgreSQL gave up waiting: a statement or lock timeout set for the transaction. */
const timedOut = (e: unknown) => {
  const code = (e as { code?: string } | null)?.code ?? (e as { cause?: { code?: string } } | null)?.cause?.code
  return code === "57014" || code === "55P03"
}

// --- The instance's API description, cached per instance and version.

const specs = new Map<
  string,
  { version: string | null; ops: SpecOperation[]; workflowFields: WorkflowFields | null; at: number }
>()

async function loadSpec(ctx: Ctx, instance: Instance, fetchImpl: typeof fetch) {
  const cached = specs.get(instance.id)
  if (cached && cached.version === instance.version && Date.now() - cached.at < 6 * 3600_000) return cached
  const res = await fetchImpl(`${instance.baseUrl.replace(/\/+$/, "")}/api/v1/openapi.yml`, {
    signal: AbortSignal.timeout(20_000),
  })
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
  } catch {
    // A document whose request bodies cannot be read still serves the access proxy.
  }
  const entry = { version: instance.version, ops, workflowFields, at: Date.now() }
  specs.set(instance.id, entry)
  ctx.log.info("n8n API description loaded", { instance: instance.name, operations: ops.length })
  return entry
}

export async function instanceSpec(ctx: Ctx, instance: Instance, fetchImpl: typeof fetch = fetch) {
  return (await loadSpec(ctx, instance, fetchImpl)).ops
}

/** The workflow fields the instance's API takes on create, or null when its description does not say. */
export async function instanceWorkflowFields(ctx: Ctx, instance: Instance, fetchImpl: typeof fetch = fetch) {
  return (await loadSpec(ctx, instance, fetchImpl)).workflowFields
}

// --- Requests

export type AccessInstanceInput = { instance: string; scopes: string[]; workflowIds?: string[] }

export type AccessRequestInput = {
  reason: string
  minutes: number
  instances: AccessInstanceInput[]
}

/** How long a request waits for the names of its workflows; the ones not read by then show as their IDs. */
const NAMES_WITHIN_MS = 5_000
const NAMES_AT_ONCE = 5
/**
 * A request is decided within this time, so the agent's command (which gives up after 15 seconds) always hears the
 * answer and never retries a request that was stored. API descriptions must load by SPECS_WITHIN_MS.
 */
export const REQUEST_WITHIN_MS = 10_000
const SPECS_WITHIN_MS = 7_000
const SPECS_AT_ONCE = 5

/**
 * The names of the requested workflows, as n8n has them now when the key may read workflows, otherwise as the
 * workflow map last saw them. Stored on the request, so the approver and the history see names even after a workflow
 * is renamed or deleted. Never fails: a name that cannot be read within the time is left out.
 */
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
    // A segment of its own in the URL; "." and ".." would name another path.
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

/** The stored name of a workflow on a request, never one inherited from Object. */
export const nameIn = (names: Record<string, string> | undefined, id: string) =>
  names && Object.hasOwn(names, id) && typeof names[id] === "string" ? names[id] : undefined

/** Runs `work` on every item, at most `limit` at a time. */
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

/** Agents with a request being made now; one server process, as supported. */
const requesting = new Set<string>()

/** One request of an agent at a time, so parallel requests cannot pass the pending limit together or pile up. */
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

  // Every instance is checked before anything is stored; the first one that does not fit refuses the request.
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
  const { maxMinutes, pendingMinutes } = await ctx.settings.get("access")
  if (input.minutes < 1 || input.minutes > maxMinutes)
    throw new AccessError("too_long", `Ask for 1 to ${maxMinutes} minutes.`)

  // The API descriptions, in parallel, within one deadline: a request is answered in time or not stored at all.
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

  const namesWithin = Math.min(NAMES_WITHIN_MS, REQUEST_WITHIN_MS - 1_000 - (Date.now() - started))
  const named = await Promise.all(
    asked.map((a) => workflowNamesOf(ctx, a.instance, a.workflowIds, { withinMs: Math.max(0, namesWithin) })),
  )

  // What is left of the time is the most the database may take, all statements together; past it, the transaction
  // is rolled back and nothing is stored. Each statement may take only what the ones before it left.
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
      // The token row is held while counting, so a revoke or another request cannot slip in between.
      const [held] = await tx.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).for("update")
      if (!held?.canRequestAccess || held.revokedAt) throw notAllowed()
      await within()
      const [pending] = await tx
        .select({ n: count() })
        .from(accessRequests)
        .where(and(eq(accessRequests.tokenId, tokenId), eq(accessRequests.status, "pending")))
      if ((pending?.n ?? 0) >= MAX_PENDING_PER_TOKEN)
        throw new AccessError(
          "too_many_pending",
          "This agent has too many access requests waiting for a decision. Wait for one to be decided, or release one.",
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
      // A last statement that ended past the time is not committed: the agent has stopped waiting for its answer.
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
    // Agents of earlier skills, which ask for one instance, read its name here.
    ...(asked.length === 1 ? { instance: asked[0]?.instance.name } : {}),
    instances: asked.map((a) => a.instance.name),
    decideBy: row.decideBy,
  }
}

/** Instance names for the audit log's target column. */
const namesTarget = (names: string[]) => {
  const text = names.join(", ")
  return text.length <= 200 ? text : `${names[0]} and ${names.length - 1} more instances`
}

/** The instances of requests, in their order, by request. */
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

/** Whether the instance is granted by an approved request (or would be by approving the draft). */
export const isGranted = (r: Pick<AccessInstanceRow, "included" | "droppedReason">) => r.included && !r.droppedReason

const sameSet = (a: string[] | null, b: string[]) =>
  a !== null && a.length === b.length && new Set([...a, ...b]).size === a.length

/** Whether the draft or the approval differs from what the agent asked for. */
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

/**
 * Set with every change of status, in the same update: the request's Telegram message no longer shows its status,
 * so it is edited again (see closeTelegramMessages).
 */
const messageOutdated = { telegramClosedAt: null }

/** One instance as an approver sets it on the request page. `allWorkflows` false needs at least one workflow. */
export type ApprovalInstance = {
  instanceId: string
  included: boolean
  scopes: string[]
  allWorkflows: boolean
  workflowIds: string[]
}

/** What an approver changed before approving: every instance to grant or leave out, and the minutes. */
export type ApprovalEdit = { minutes: number; instances: ApprovalInstance[] }

type Target = {
  existing?: AccessInstanceRow
  instanceId: string | null
  instanceName: string
  included: boolean
  scopes: string[]
  workflowIds: string[]
}

/** Checks an edit's shape before anything is read: workflow lists, duplicates. */
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

/**
 * Approves a pending request: as it stands (the draft, which Telegram edits), or with the edit an approver made on
 * the request page. `revision` is the revision the approver saw; if the request was edited since, nothing is
 * approved. The request and every instance involved are locked while the grant is decided, so a policy saved at the
 * same time either comes first and is applied, or waits until the approval is stored. An instance closed or deleted
 * by now is left out, and so are scopes its policy no longer allows; with nothing left, nothing is approved.
 */
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

  // Names of workflows an approver added are read before the transaction; reading them never fails.
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
          // An instance deleted since the page was loaded has lost its ID on the request; it is found by its row.
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
    // Instances of the request the edit does not name are left out. A deleted one can no longer be named: it keeps
    // its place in the draft, so the approval says it was left out because it was deleted.
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

    // Locked in one order, the one updateInstance takes, so two approvals and a policy save never deadlock.
    const ids = [...new Set(targets.filter((t) => t.included && t.instanceId).map((t) => t.instanceId as string))]
    const locked = ids.length
      ? await tx.select().from(instances).where(inArray(instances.id, ids)).orderBy(asc(instances.id)).for("update")
      : []
    const byId = new Map(locked.map((i) => [i.id, i]))

    // An instance an approver added that was deleted before the approval is not part of the request at all.
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
      // The names of what was asked for stay with the request too, so its history keeps them after a change.
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

/** A change of the draft from Telegram: include or leave out one instance, or set the minutes. */
export type DraftChange = { position: number; included: boolean } | { minutes: number }

/**
 * Changes the draft of a pending request, only while it is still at the revision the approver saw, and moves it to
 * the next revision. The change sets a value (never flips one), so a press sent twice does not undo itself.
 */
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
  // Open request pages and cards load the new revision, so they show and approve what the message shows.
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

/** Ends access now: a pending request cannot be approved any more, an approved key stops working. */
export async function revokeAccess(ctx: Ctx, id: string, who: Decider) {
  const updated = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(accessRequests)
      .set({ status: "revoked", endedAt: new Date(), keyEnc: null, ...messageOutdated })
      .where(and(eq(accessRequests.id, id), inArray(accessRequests.status, ["pending", "approved"])))
      .returning()
    if (!row) throw new AccessError("not_active", "The request is not pending or active.")
    await auditDecision(ctx, tx, id, "Instance access revoked", who)
    return row
  })
  changed(ctx, "access", "overview")
  return updated
}

/** Revokes everything a token asked for or holds; used when the token itself is revoked. */
export async function revokeAccessOfToken(ctx: Ctx, tokenId: string, who: Decider) {
  const rows = await ctx.db
    .select({ id: accessRequests.id })
    .from(accessRequests)
    .where(and(eq(accessRequests.tokenId, tokenId), inArray(accessRequests.status, ["pending", "approved"])))
  for (const r of rows) await revokeAccess(ctx, r.id, who).catch(() => undefined)
}

/** The audit entry of a decision or an end, written in the transaction that made it. */
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

/** The proxy address of an instance for agents. */
const proxyBase = (publicUrl: string, instanceName: string) =>
  `${publicUrl.replace(/\/+$/, "")}/n8n/${encodeURIComponent(instanceName)}/api/v1`

/**
 * What the agent sees about its own request. The key is returned once, on the first look after approval,
 * together with how to use it; after that only its prefix. `instances` lists what was asked for while the request
 * waits, and what was granted once approved (an approver may have changed it). The single-instance fields
 * (`instance`, `scopes`, `workflowIds`, `baseUrl`) that agents of earlier skills read always describe one of them:
 * the first instance asked for that was granted, else the first granted.
 */
export async function collectAccess(ctx: Ctx, tokenId: string, id: string, publicUrl: string) {
  const [r] = await ctx.db
    .select()
    .from(accessRequests)
    .where(and(eq(accessRequests.id, id), eq(accessRequests.tokenId, tokenId)))
  if (!r) throw new AccessError("not_found", "This agent has no such access request.")
  const children = (await instancesOf(ctx.db, [id])).get(id) ?? []
  // The name the instance has now, so the proxy address keeps working after a rename.
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

/** The longest summary kept, in characters (code points). */
export const SUMMARY_MAX = 1000

/**
 * A summary as it is stored: without NUL, which PostgreSQL cannot keep in text, trimmed, and clipped on whole
 * characters. Never refused, so a summary cannot keep a key working by failing its release. Empty is none.
 */
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
  // The summary is kept by the same update that ends the access, so a release that comes too late changes nothing.
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

/** Background job: pending requests nobody decided, and approved access whose time is up. */
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

// --- The proxy's view of a key

/**
 * The grant a key gives on the instance a call names (by name or ID): null when the key is unknown or no longer
 * works; `grant` null when the key works but not on that instance.
 */
export async function grantForKey(ctx: Ctx, key: string, ref: string) {
  if (!key.startsWith(`${KEY_PREFIX}_`)) return null
  const [row] = await ctx.db
    .select({ r: accessRequests, tokenRevokedAt: apiTokens.revokedAt })
    .from(accessRequests)
    .innerJoin(apiTokens, eq(accessRequests.tokenId, apiTokens.id))
    .where(eq(accessRequests.keyHash, sha256(key)))
  if (row?.r.status !== "approved" || row.tokenRevokedAt) return null
  if (!row.r.expiresAt || row.r.expiresAt < new Date()) return null
  const matches = await ctx.db
    .select({ grant: accessRequestInstances, instance: instances })
    .from(accessRequestInstances)
    .innerJoin(instances, eq(accessRequestInstances.instanceId, instances.id))
    .where(
      and(
        eq(accessRequestInstances.requestId, row.r.id),
        eq(accessRequestInstances.included, true),
        sql`${accessRequestInstances.droppedReason} is null`,
        isUuid(ref) ? or(eq(instances.id, ref), eq(instances.name, ref)) : eq(instances.name, ref),
      ),
    )
  // The name first: the addresses given to the agent use names, and one key opens several instances, so an instance
  // named like another one's ID must still get the calls sent to its own address.
  const found =
    matches.find((m) => m.instance.name === ref) ?? matches.find((m) => m.instance.id === ref.toLowerCase())
  return { request: row.r, grant: found?.grant ?? null, instance: found?.instance ?? null }
}

export type Decision = { allowed: true } | { allowed: false; reason: string }

/** Whether a call fits the grant: a known operation, inside the scopes, and on an allowed workflow. */
export function checkCall(
  ops: SpecOperation[],
  grant: { scopes: string[]; workflowIds: string[] },
  method: string,
  path: string,
  query: URLSearchParams,
): Decision & { workflowFilter?: boolean; executionId?: string } {
  const match = matchOperation(ops, method, path)
  if (!match) return { allowed: false, reason: `${method} ${path} is not an n8n public API operation.` }
  const missing = match.op.scopes.filter((s) => !grant.scopes.includes(s))
  if (missing.length)
    return { allowed: false, reason: `Needs ${missing.join(", ")}, which this access does not include.` }
  if (!grant.workflowIds.length) return { allowed: true }
  const allowed = new Set(grant.workflowIds)
  const workflowId = match.params.workflowId
  if (workflowId !== undefined)
    return allowed.has(workflowId)
      ? { allowed: true }
      : { allowed: false, reason: `Workflow ${workflowId} is outside this access.` }
  if (match.op.template === "/workflows" && method === "GET") return { allowed: true, workflowFilter: true }
  if (match.op.template === "/workflows" && method === "POST")
    return { allowed: false, reason: "This access is limited to its workflows; it cannot create new ones." }
  if (match.op.template === "/executions" && method === "GET") {
    const w = query.get("workflowId")
    return w && allowed.has(w)
      ? { allowed: true }
      : { allowed: false, reason: "Pass workflowId with one of the workflows of this access." }
  }
  if (match.params.executionId !== undefined) return { allowed: true, executionId: match.params.executionId }
  if (match.op.template.startsWith("/executions"))
    return { allowed: false, reason: "This operation spans executions of other workflows." }
  return { allowed: true }
}

export async function logCall(
  ctx: Ctx,
  requestId: string,
  call: { instanceId: string | null; method: string; path: string; status: number; refused?: string },
) {
  // One transaction: the call and its count are kept together. A call that ends after the access did (it started
  // before) marks the Telegram message as outdated, so the next run shows it in the count.
  await ctx.db.transaction(async (tx) => {
    await tx.insert(accessCalls).values({ requestId, ...call, refused: call.refused ?? null })
    await tx
      .update(accessRequests)
      .set({
        callCount: sql`${accessRequests.callCount} + 1`,
        telegramClosedAt: sql`CASE WHEN ${accessRequests.status} IN ('released', 'expired', 'revoked') THEN NULL ELSE ${accessRequests.telegramClosedAt} END`,
      })
      .where(eq(accessRequests.id, requestId))
  })
  // An open request page shows the new call and count; the event stream sends at most one change a second.
  changed(ctx, "access")
}

/** Calls n8n-ops refused, by request; a request without any is left out. */
export async function refusedCounts(ctx: Ctx, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map()
  const rows = await ctx.db
    .select({ id: accessCalls.requestId, n: count() })
    .from(accessCalls)
    .where(and(inArray(accessCalls.requestId, ids), isNotNull(accessCalls.refused)))
    .groupBy(accessCalls.requestId)
  return new Map(rows.map((r) => [r.id, r.n]))
}

// --- For the UI

/** An instance of a request as the UI shows it. */
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
  const rows = await ctx.db
    .select({ r: accessRequests, tokenName: apiTokens.name })
    .from(accessRequests)
    .innerJoin(apiTokens, eq(accessRequests.tokenId, apiTokens.id))
    .orderBy(desc(accessRequests.requestedAt))
    .limit(200)
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
  // One snapshot, so the count, the refused count and the calls listed agree while calls are being logged.
  const read = await ctx.db.transaction(
    async (tx) => {
      const [row] = await tx
        .select({ r: accessRequests, tokenName: apiTokens.name })
        .from(accessRequests)
        .innerJoin(apiTokens, eq(accessRequests.tokenId, apiTokens.id))
        .where(eq(accessRequests.id, id))
      if (!row) return null
      const children = (await instancesOf(tx, [id])).get(id) ?? []
      const calls = await tx
        .select()
        .from(accessCalls)
        .where(eq(accessCalls.requestId, id))
        .orderBy(desc(accessCalls.at))
        .limit(500)
      const [refused] = await tx
        .select({ n: count() })
        .from(accessCalls)
        .where(and(eq(accessCalls.requestId, id), isNotNull(accessCalls.refused)))
      return { row, children, calls, refusedCount: refused?.n ?? 0 }
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  )
  if (!read) return null
  const { row, children, calls, refusedCount } = read
  const current = await currentNames(
    ctx.db,
    children.flatMap((c) => (c.instanceId ? [c.instanceId] : [])),
  )
  // Requests made before names were stored take them from the workflow map, while it still lists the workflow.
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
  // While it waits, the editor shows what each instance may be granted now, and the other instances it may add.
  const editor = pending ? await editorChoices(ctx, list) : undefined
  const callNames = new Map(list.flatMap((c) => (c.instanceId ? [[c.instanceId, c.name]] : [])))
  return {
    ...publicFields(row.r),
    instances: list,
    changed: differsFromAsked(row.r, children),
    token: row.tokenName,
    calls: calls.map((c) => ({ ...c, instance: c.instanceId ? (callNames.get(c.instanceId) ?? null) : null })),
    refusedCount,
    ...(editor ? { editor } : {}),
  }
}

/** The instances open to agents, each with the scopes it may grant now, for the approval editor. */
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

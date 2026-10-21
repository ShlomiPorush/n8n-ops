import { and, desc, eq, inArray, lt, or } from "drizzle-orm"
import { type Ctx, changed } from "../context.ts"
import { type AccessStatus, accessCalls, accessRequests, apiTokens, instances } from "../db/schema.ts"
import { tokenActor } from "../http/types.ts"
import type { AuditVia } from "../lib/audit.ts"
import { newToken, sha256 } from "../lib/crypto.ts"
import { matchOperation, parseSpec, type SpecOperation, specHasScopes } from "../lib/n8n-spec.ts"
import { effectiveScopes, type Instance } from "./instances.ts"

/**
 * Temporary access for agents to n8n instances. An agent asks for an instance, scopes, optional workflows and a
 * duration with a reason; a person approves or denies; an approved request gets a key the agent collects once
 * and uses against the n8n-ops proxy (/n8n/<instance>/api/v1/...), which checks every call and forwards it with
 * the instance's own key. The key stops working when the time is up, when the agent releases it, or on revoke.
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

/** Scopes an agent may be granted on an instance: allowed by its policy and held by its API key. */
export function grantableScopes(
  instance: Pick<Instance, "agentAccess" | "scopes" | "scopesSource" | "declaredAccess">,
) {
  if (!instance.agentAccess.enabled) return []
  const held = new Set(effectiveScopes(instance))
  return instance.agentAccess.scopes.filter((s) => held.has(s))
}

async function findInstance(ctx: Ctx, ref: string) {
  const isId = /^[0-9a-f-]{36}$/i.test(ref)
  const [row] = await ctx.db
    .select()
    .from(instances)
    .where(isId ? or(eq(instances.id, ref), eq(instances.name, ref)) : eq(instances.name, ref))
  return row ?? null
}

// --- The instance's API description, cached per instance and version.

const specs = new Map<string, { version: string | null; ops: SpecOperation[]; at: number }>()

export async function instanceSpec(ctx: Ctx, instance: Instance, fetchImpl: typeof fetch = fetch) {
  const cached = specs.get(instance.id)
  if (cached && cached.version === instance.version && Date.now() - cached.at < 6 * 3600_000) return cached.ops
  const res = await fetchImpl(`${instance.baseUrl.replace(/\/+$/, "")}/api/v1/openapi.yml`, {
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new AccessError("spec_unavailable", `n8n did not return its API description (HTTP ${res.status}).`)
  const ops = parseSpec(await res.text())
  if (!specHasScopes(ops))
    throw new AccessError(
      "spec_without_scopes",
      "This n8n version does not describe API key scopes; it needs 2.14 or later.",
    )
  specs.set(instance.id, { version: instance.version, ops, at: Date.now() })
  ctx.log.info("n8n API description loaded", { instance: instance.name, operations: ops.length })
  return ops
}

// --- Requests

export type AccessRequestInput = {
  instance: string
  reason: string
  scopes: string[]
  workflowIds?: string[]
  minutes: number
}

export async function requestAccess(ctx: Ctx, tokenId: string, input: AccessRequestInput) {
  const [token] = await ctx.db.select().from(apiTokens).where(eq(apiTokens.id, tokenId))
  if (!token?.canRequestAccess || token.revokedAt)
    throw new AccessError("not_allowed", "This token may not request access to n8n instances.")
  const instance = await findInstance(ctx, input.instance)
  if (!instance) throw new AccessError("unknown_instance", `There is no instance named "${input.instance}".`)
  if (!instance.agentAccess.enabled)
    throw new AccessError("instance_closed", `Agents may not request access to ${instance.name}.`)
  const grantable = grantableScopes(instance)
  const scopes = [...new Set(input.scopes)]
  const extra = scopes.filter((s) => !grantable.includes(s))
  if (!scopes.length || extra.length)
    throw new AccessError(
      "scopes_not_grantable",
      `${extra.length ? `Not grantable on ${instance.name}: ${extra.join(", ")}. ` : "Ask for at least one scope. "}Grantable: ${grantable.join(", ") || "none"}.`,
    )
  const { maxMinutes, pendingMinutes } = await ctx.settings.get("access")
  if (input.minutes < 1 || input.minutes > maxMinutes)
    throw new AccessError("too_long", `Ask for 1 to ${maxMinutes} minutes.`)
  await instanceSpec(ctx, instance)
  const pending = await ctx.db
    .select({ id: accessRequests.id })
    .from(accessRequests)
    .where(and(eq(accessRequests.tokenId, tokenId), eq(accessRequests.status, "pending")))
  if (pending.length >= MAX_PENDING_PER_TOKEN)
    throw new AccessError("too_many_pending", "This token already has requests waiting for a decision.")

  const [row] = await ctx.db
    .insert(accessRequests)
    .values({
      tokenId,
      instanceId: instance.id,
      reason: input.reason,
      scopes,
      workflowIds: [...new Set(input.workflowIds ?? [])],
      minutes: input.minutes,
      decideBy: new Date(Date.now() + pendingMinutes * 60_000),
    })
    .returning()
  if (!row) throw new Error("the request was not stored")
  await ctx.audit({
    actor: tokenActor(token),
    action: "Instance access requested",
    target: instance.name,
    via: "agent",
    details: { requestId: row.id, scopes, workflowIds: row.workflowIds, minutes: input.minutes, reason: input.reason },
  })
  changed(ctx, "access", "overview")
  ctx.events.emit("access-requested", row.id)
  return { id: row.id, status: row.status, instance: instance.name, decideBy: row.decideBy }
}

type Decider = { by: string; via: AuditVia }

async function pendingRequest(ctx: Ctx, id: string) {
  const [row] = await ctx.db.select().from(accessRequests).where(eq(accessRequests.id, id))
  if (!row) throw new AccessError("not_found", "There is no such request.")
  if (row.status !== "pending") throw new AccessError("already_decided", `The request is already ${row.status}.`)
  if (row.decideBy < new Date()) throw new AccessError("already_decided", "The request expired before a decision.")
  return row
}

/**
 * Set with every change of status, in the same update: the request's Telegram message no longer shows its status,
 * so it is edited again (see closeTelegramMessages).
 */
const messageOutdated = { telegramClosedAt: null }

export async function approveAccess(ctx: Ctx, id: string, who: Decider) {
  const row = await pendingRequest(ctx, id)
  const key = newToken(KEY_PREFIX)
  const now = new Date()
  const [updated] = await ctx.db
    .update(accessRequests)
    .set({
      status: "approved",
      decidedAt: now,
      decidedBy: who.by,
      decidedVia: who.via,
      expiresAt: new Date(now.getTime() + row.minutes * 60_000),
      keyPrefix: key.slice(0, KEY_PREFIX.length + 5),
      keyHash: sha256(key),
      keyEnc: ctx.secrets.encrypt(key),
      ...messageOutdated,
    })
    // Only one decision wins if two approvers press at once.
    .where(and(eq(accessRequests.id, id), eq(accessRequests.status, "pending")))
    .returning()
  if (!updated) throw new AccessError("already_decided", "The request was decided meanwhile.")
  await auditDecision(ctx, updated.id, "Instance access approved", who)
  return updated
}

export async function denyAccess(ctx: Ctx, id: string, who: Decider) {
  await pendingRequest(ctx, id)
  const [updated] = await ctx.db
    .update(accessRequests)
    .set({ status: "denied", decidedAt: new Date(), decidedBy: who.by, decidedVia: who.via, ...messageOutdated })
    .where(and(eq(accessRequests.id, id), eq(accessRequests.status, "pending")))
    .returning()
  if (!updated) throw new AccessError("already_decided", "The request was decided meanwhile.")
  await auditDecision(ctx, updated.id, "Instance access denied", who)
  return updated
}

/** Ends access now: a pending request cannot be approved any more, an approved key stops working. */
export async function revokeAccess(ctx: Ctx, id: string, who: Decider) {
  const [updated] = await ctx.db
    .update(accessRequests)
    .set({ status: "revoked", endedAt: new Date(), keyEnc: null, ...messageOutdated })
    .where(and(eq(accessRequests.id, id), inArray(accessRequests.status, ["pending", "approved"])))
    .returning()
  if (!updated) throw new AccessError("not_active", "The request is not pending or active.")
  await auditDecision(ctx, updated.id, "Instance access revoked", who)
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

async function auditDecision(ctx: Ctx, id: string, action: string, who: Decider) {
  const [row] = await ctx.db
    .select({ instance: instances.name, token: apiTokens.name, tokenId: apiTokens.id })
    .from(accessRequests)
    .innerJoin(instances, eq(accessRequests.instanceId, instances.id))
    .innerJoin(apiTokens, eq(accessRequests.tokenId, apiTokens.id))
    .where(eq(accessRequests.id, id))
  await ctx.audit({
    actor: who.by,
    action,
    target: `${row?.instance ?? "?"} for ${row ? tokenActor({ id: row.tokenId, name: row.token }) : "token:?"}`,
    via: who.via,
    details: { requestId: id },
  })
  changed(ctx, "access", "overview")
}

/**
 * What the agent sees about its own request. The key is returned once, on the first look after approval,
 * together with how to use it; after that only its prefix.
 */
export async function collectAccess(ctx: Ctx, tokenId: string, id: string, publicUrl: string) {
  const [row] = await ctx.db
    .select({ r: accessRequests, instanceName: instances.name })
    .from(accessRequests)
    .innerJoin(instances, eq(accessRequests.instanceId, instances.id))
    .where(and(eq(accessRequests.id, id), eq(accessRequests.tokenId, tokenId)))
  if (!row) throw new AccessError("not_found", "There is no such request for this token.")
  const { r } = row
  const status: AccessStatus = r.status === "pending" && r.decideBy < new Date() ? "expired" : r.status
  const base = {
    id: r.id,
    status,
    instance: row.instanceName,
    scopes: r.scopes,
    workflowIds: r.workflowIds,
    requestedAt: r.requestedAt,
    decidedBy: r.decidedBy,
    expiresAt: r.expiresAt,
  }
  if (status !== "approved") return base
  const usage = {
    baseUrl: `${publicUrl.replace(/\/+$/, "")}/n8n/${encodeURIComponent(row.instanceName)}/api/v1`,
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

export async function releaseAccess(ctx: Ctx, tokenId: string, id: string) {
  const [row] = await ctx.db
    .select({ id: apiTokens.id, name: apiTokens.name })
    .from(accessRequests)
    .innerJoin(apiTokens, eq(accessRequests.tokenId, apiTokens.id))
    .where(and(eq(accessRequests.id, id), eq(accessRequests.tokenId, tokenId)))
  if (!row) throw new AccessError("not_found", "There is no such request for this token.")
  const [updated] = await ctx.db
    .update(accessRequests)
    .set({ status: "released", endedAt: new Date(), keyEnc: null, ...messageOutdated })
    .where(and(eq(accessRequests.id, id), inArray(accessRequests.status, ["pending", "approved"])))
    .returning()
  if (!updated) throw new AccessError("not_active", "The request is not pending or active.")
  await auditDecision(ctx, id, "Instance access released", { by: tokenActor(row), via: "agent" })
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

export async function grantForKey(ctx: Ctx, key: string) {
  if (!key.startsWith(`${KEY_PREFIX}_`)) return null
  const [row] = await ctx.db
    .select({ r: accessRequests, instance: instances, tokenRevokedAt: apiTokens.revokedAt })
    .from(accessRequests)
    .innerJoin(instances, eq(accessRequests.instanceId, instances.id))
    .innerJoin(apiTokens, eq(accessRequests.tokenId, apiTokens.id))
    .where(eq(accessRequests.keyHash, sha256(key)))
  if (row?.r.status !== "approved" || row.tokenRevokedAt) return null
  if (!row.r.expiresAt || row.r.expiresAt < new Date()) return null
  return { request: row.r, instance: row.instance }
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
    return { allowed: false, reason: "This access is limited to existing workflows; it cannot create new ones." }
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
  call: { method: string; path: string; status: number; refused?: string },
) {
  await ctx.db.insert(accessCalls).values({ requestId, ...call, refused: call.refused ?? null })
}

// --- For the UI

export async function listAccess(ctx: Ctx) {
  const rows = await ctx.db
    .select({ r: accessRequests, instanceName: instances.name, tokenName: apiTokens.name })
    .from(accessRequests)
    .innerJoin(instances, eq(accessRequests.instanceId, instances.id))
    .innerJoin(apiTokens, eq(accessRequests.tokenId, apiTokens.id))
    .orderBy(desc(accessRequests.requestedAt))
    .limit(200)
  return rows.map(({ r, instanceName, tokenName }) => ({
    ...publicFields(r),
    instance: instanceName,
    token: tokenName,
  }))
}

export async function getAccess(ctx: Ctx, id: string) {
  const [row] = await ctx.db
    .select({ r: accessRequests, instanceName: instances.name, tokenName: apiTokens.name })
    .from(accessRequests)
    .innerJoin(instances, eq(accessRequests.instanceId, instances.id))
    .innerJoin(apiTokens, eq(accessRequests.tokenId, apiTokens.id))
    .where(eq(accessRequests.id, id))
  if (!row) return null
  const calls = await ctx.db
    .select()
    .from(accessCalls)
    .where(eq(accessCalls.requestId, id))
    .orderBy(desc(accessCalls.at))
    .limit(500)
  return { ...publicFields(row.r), instance: row.instanceName, token: row.tokenName, calls }
}

function publicFields(r: typeof accessRequests.$inferSelect) {
  const { keyHash: _h, keyEnc: _e, ...rest } = r
  return { ...rest, keyCollected: Boolean(r.keyCollectedAt) }
}

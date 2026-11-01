import { belowMinimum, type CapabilityKey, unsupportedVersionText } from "@n8n-ops/shared"
import { and, eq, isNotNull, type SQL, sql } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { instances } from "../db/schema.ts"
import { oneAtATime } from "../lib/one-at-a-time.ts"
import { N8nClient, N8nError } from "../n8n/client.ts"

export type Instance = typeof instances.$inferSelect

/** The instance has no API key stored: whatever needs the n8n API cannot run. */
export class NoApiKey extends Error {
  constructor(name: string) {
    super(`${name} has no API key. Add one in its settings.`)
  }
}

export function clientFor(ctx: Ctx, instance: Pick<Instance, "name" | "baseUrl" | "apiKeyEnc">): N8nClient {
  if (!instance.apiKeyEnc) throw new NoApiKey(instance.name)
  return new N8nClient(instance.baseUrl, ctx.secrets.decrypt(instance.apiKeyEnc))
}

/** Whether the instance finished its setup; a draft does nothing in the background. */
export const isActive = (instance: Pick<Instance, "setupState">) => instance.setupState === "complete"

/** Whether the instance is active and was chosen for `capability` (docs/adr/0002). */
export const can = (instance: Pick<Instance, "setupState" | "chosenCapabilities">, capability: CapabilityKey) =>
  isActive(instance) && instance.chosenCapabilities.includes(capability)

/** The same as `can`, as a filter for the background loops; admin lists show every instance. */
export const activeWith = (capability: CapabilityKey): SQL =>
  and(
    eq(instances.setupState, "complete"),
    sql`${instances.chosenCapabilities} @> ${JSON.stringify([capability])}::jsonb`,
  ) as SQL

/** Active instances only, for the overview, reports and agents. */
export const activeOnly = eq(instances.setupState, "complete")

/** Instances with a key, for the meta refresh. */
export const withKey = isNotNull(instances.apiKeyEnc)

/** Why a key test failed: n8n refused the key, it is older than the minimum, or it could not be reached. */
export type KeyTest =
  | { ok: true; version: string | null; scopes: string[] }
  | { ok: false; code: "key_refused" | "unsupported_version" | "unreachable"; error: string; version: string | null }

/**
 * The one key test (setup and edits): n8n answers, accepts the key, and is 2.14.0 or later. It returns the key's
 * scopes from /discover; it never judges them, so a key with fewer scopes is still a valid key.
 */
export async function testKey(baseUrl: string, apiKey: string, client = new N8nClient(baseUrl, apiKey)) {
  const version = await client.version().catch(() => null)
  const fail = (code: Exclude<KeyTest, { ok: true }>["code"], error: string): KeyTest => ({
    ok: false,
    code,
    error,
    version,
  })
  if (version && belowMinimum(version)) return fail("unsupported_version", unsupportedVersionText)
  try {
    const scopes = await client.discoverScopes()
    if (scopes === null) return fail("unsupported_version", unsupportedVersionText)
    return { ok: true, version, scopes } satisfies KeyTest
  } catch (error) {
    if (error instanceof N8nError && (error.status === 401 || error.status === 403))
      return fail("key_refused", "n8n refused the API key.")
    return fail("unreachable", `Cannot reach n8n at ${baseUrl}: ${(error as Error).message}`)
  }
}

/** The turn an instance's health reports, its version writes and its changes take, one at a time. */
export const healthTurn = (instanceId: string) => `health:${instanceId}`

/**
 * Whether the version comes from the worker reading inside: health is collected that way now, and the last report
 * had one. With health off no report comes, so the one stored is history and the version is read over the network.
 */
export function versionFromInside(
  instance: Pick<
    Instance,
    | "collection"
    | "workerId"
    | "containerName"
    | "composeProject"
    | "composeService"
    | "healthDetail"
    | "setupState"
    | "chosenCapabilities"
  >,
) {
  const detail = instance.healthDetail as { source?: string; version?: string } | null
  return can(instance, "health") && readsInside(instance) && detail?.source === "inside" && Boolean(detail.version)
}

/** Whether the worker on the host reads the instance from inside its main container. */
/** Where the main is: a container name, or a Compose project and service; nothing when neither is set. */
export type MainTarget = { name: string } | { project: string; service: string }

export function mainTarget(
  instance: Pick<Instance, "containerName" | "composeProject" | "composeService">,
): MainTarget | null {
  if (instance.composeProject && instance.composeService)
    return { project: instance.composeProject, service: instance.composeService }
  return instance.containerName ? { name: instance.containerName } : null
}

export function readsInside(
  instance: Pick<Instance, "collection" | "workerId" | "containerName" | "composeProject" | "composeService">,
) {
  return instance.collection === "worker" && Boolean(instance.workerId) && mainTarget(instance) !== null
}

/**
 * Whether n8n-ops finds this instance's queue workers through Docker, so the socket proxy must allow them: read
 * from inside, no worker URLs typed, and queue mode, or a mode not found yet (a main in queue mode the proxy
 * refuses never tells its mode).
 */
export function needsQueueWorkers(
  instance: Pick<
    Instance,
    | "collection"
    | "workerId"
    | "containerName"
    | "composeProject"
    | "composeService"
    | "queueMode"
    | "queueModeSource"
    | "workerHealthUrls"
  >,
) {
  return (
    readsInside(instance) &&
    instance.workerHealthUrls.length === 0 &&
    (instance.queueMode || instance.queueModeSource !== "found")
  )
}

/**
 * Where the queue metrics of an instance are read over the network: the URL set on it, otherwise /metrics of its
 * base URL, where n8n serves them. Only in queue mode: outside it there is no queue to read, so nothing is asked.
 */
export function metricsUrlOf(instance: Pick<Instance, "metricsUrl" | "queueMode" | "baseUrl">): string | null {
  if (!instance.queueMode) return null
  return instance.metricsUrl || `${instance.baseUrl.replace(/\/+$/, "")}/metrics`
}

type CollectionFields = Pick<
  Instance,
  | "collection"
  | "workerId"
  | "containerName"
  | "composeProject"
  | "composeService"
  | "queueMode"
  | "queueModeSource"
  | "baseUrl"
  | "metricsUrl"
  | "workerHealthUrls"
>

/**
 * What an update means for how health is collected. The target (collection, worker, container) is where a found
 * mode was read: changing it clears the found mode, so a manual value counts until the new target is read. While
 * the mode is found and the target stays, a queue mode in the update is ignored, whoever sends it. Any change to
 * how health is collected raises the collection revision, so checks that started before are dropped.
 */
export function collectionUpdate(row: CollectionFields, next: Partial<CollectionFields>) {
  const differs = <K extends keyof CollectionFields>(key: K) =>
    next[key] !== undefined && JSON.stringify(next[key] ?? null) !== JSON.stringify(row[key] ?? null)
  const targetChanged =
    differs("collection") ||
    differs("workerId") ||
    differs("containerName") ||
    differs("composeProject") ||
    differs("composeService")
  const locked = row.queueModeSource === "found" && !targetChanged
  const queueModeChanged = !locked && differs("queueMode")
  return {
    /** The queue mode to store, or undefined to keep the stored one. */
    queueMode: locked ? undefined : next.queueMode,
    queueModeSource: targetChanged ? ("manual" as const) : undefined,
    raiseRevision:
      targetChanged || queueModeChanged || differs("baseUrl") || differs("metricsUrl") || differs("workerHealthUrls"),
  }
}

/** The scopes n8n-ops may rely on: those n8n reports for the key; none on n8n older than 2.14.0. */
export function effectiveScopes(instance: Pick<Instance, "scopes">): string[] {
  return instance.scopes ?? []
}

/** n8n is older than 2.14.0: the key was read and n8n has no /discover, or its version is known to be older. */
export const unsupportedVersion = (instance: Pick<Instance, "apiKeyEnc" | "scopes" | "scopesCheckedAt" | "version">) =>
  Boolean(
    (instance.apiKeyEnc && instance.scopesCheckedAt && instance.scopes === null) ||
      (instance.version && belowMinimum(instance.version)),
  )

/**
 * Reads the n8n version and the API key's scopes, and stores them. It works from the row as it is when its turn
 * comes, does nothing without a key, and stores nothing when the configuration changed meanwhile (a new URL or key
 * is read by its own refresh). Returns the row as stored, or as it was when nothing was read.
 */
export function refreshInstanceMeta(ctx: Ctx, instance: Pick<Instance, "id">) {
  // One at a time per instance, so a slow earlier read never writes over a later one.
  return oneAtATime(`meta:${instance.id}`, () => refreshInstanceMetaNow(ctx, instance.id))
}

async function refreshInstanceMetaNow(ctx: Ctx, id: string): Promise<Instance | undefined> {
  const [instance] = await ctx.db.select().from(instances).where(eq(instances.id, id))
  if (!instance?.apiKeyEnc) return instance
  const client = clientFor(ctx, instance)
  // While the worker reports a version from inside, reading it over the network would race it. A worker that
  // checks over the network, or one of an earlier release, reports none: then it is read here, as before.
  const [version, scopes] = await Promise.all([
    versionFromInside(instance) ? Promise.resolve(null) : client.version(instance.metricsUrl),
    client.discoverScopes(),
  ])
  if (version) {
    // Only a version actually read, only while collection is as it was when the read started, and not once the
    // worker has reported one from inside meanwhile: decided in the instance's turn with its health reports.
    await oneAtATime(healthTurn(instance.id), async () => {
      const [now] = await ctx.db.select().from(instances).where(eq(instances.id, instance.id))
      if (!now || now.collectionRevision !== instance.collectionRevision || versionFromInside(now)) return
      await ctx.db.update(instances).set({ version }).where(eq(instances.id, instance.id))
    })
  }
  const before = new Set(effectiveScopes(instance))
  const patch = { scopes, scopesCheckedAt: new Date(), updatedAt: new Date() }
  const [saved] = await ctx.db
    .update(instances)
    .set(patch)
    .where(and(eq(instances.id, instance.id), eq(instances.configRevision, instance.configRevision)))
    .returning()
  if (!saved) return instance
  const after = effectiveScopes(saved)
  const added = after.filter((s) => !before.has(s))
  const removed = [...before].filter((s) => !after.includes(s))
  if (instance.scopesCheckedAt && (added.length || removed.length)) {
    await ctx.audit({
      actor: "system",
      action: "API key scopes changed",
      target: instance.name,
      via: "system",
      details: { added, removed },
    })
  }
  return saved
}

/** Link to an execution in the n8n editor. */
export function executionUrl(instance: Pick<Instance, "baseUrl">, workflowId: string, executionId: string) {
  return `${instance.baseUrl.replace(/\/+$/, "")}/workflow/${encodeURIComponent(workflowId)}/executions/${encodeURIComponent(executionId)}`
}

export function workflowUrl(instance: Pick<Instance, "baseUrl">, workflowId: string) {
  return `${instance.baseUrl.replace(/\/+$/, "")}/workflow/${encodeURIComponent(workflowId)}`
}

let latest: { version: string | null; at: number } = { version: null, at: 0 }

/** Latest n8n release from GitHub, cached for six hours. */
export async function latestN8nVersion(): Promise<string | null> {
  if (Date.now() - latest.at < 6 * 3600_000) return latest.version
  try {
    const res = await fetch("https://api.github.com/repos/n8n-io/n8n/releases/latest", {
      headers: { accept: "application/vnd.github+json", "user-agent": "n8n-ops" },
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json()) as { tag_name?: string }
    latest = { version: body.tag_name?.replace(/^n8n@/, "") ?? null, at: Date.now() }
  } catch {
    latest = { version: latest.version, at: Date.now() - 5 * 3600_000 }
  }
  return latest.version
}

/** -1, 0 or 1 comparing dotted versions numerically. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  return 0
}

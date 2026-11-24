import { belowMinimum, type CapabilityKey, unsupportedVersionText } from "@n8n-ops/shared"
import { and, eq, isNotNull, type SQL, sql } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { instances } from "../db/schema.ts"
import { oneAtATime } from "../lib/one-at-a-time.ts"
import { type FetchLike, N8nClient, N8nError } from "../n8n/client.ts"

export type Instance = typeof instances.$inferSelect

export class NoApiKey extends Error {
  constructor(name: string) {
    super(`${name} has no API key. Add one in its settings.`)
  }
}

export function clientFor(ctx: Ctx, instance: Pick<Instance, "name" | "baseUrl" | "apiKeyEnc">): N8nClient {
  if (!instance.apiKeyEnc) throw new NoApiKey(instance.name)
  return new N8nClient(instance.baseUrl, ctx.secrets.decrypt(instance.apiKeyEnc))
}

export const isActive = (instance: Pick<Instance, "setupState">) => instance.setupState === "complete"

export const can = (instance: Pick<Instance, "setupState" | "chosenCapabilities">, capability: CapabilityKey) =>
  isActive(instance) && instance.chosenCapabilities.includes(capability)

export const activeWith = (capability: CapabilityKey): SQL =>
  and(
    eq(instances.setupState, "complete"),
    sql`${instances.chosenCapabilities} @> ${JSON.stringify([capability])}::jsonb`,
  ) as SQL

export const activeOnly = eq(instances.setupState, "complete")

export const withKey = isNotNull(instances.apiKeyEnc)

export type KeyTest =
  | { ok: true; version: string | null; scopes: string[] }
  | { ok: false; code: "key_refused" | "unsupported_version" | "unreachable"; error: string; version: string | null }

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
    queueMode: locked ? undefined : next.queueMode,
    queueModeSource: targetChanged ? ("manual" as const) : undefined,
    raiseRevision:
      targetChanged || queueModeChanged || differs("baseUrl") || differs("metricsUrl") || differs("workerHealthUrls"),
  }
}

export function effectiveScopes(instance: Pick<Instance, "scopes">): string[] {
  return instance.scopes ?? []
}

export const unsupportedVersion = (instance: Pick<Instance, "apiKeyEnc" | "scopes" | "scopesCheckedAt" | "version">) =>
  Boolean(
    (instance.apiKeyEnc && instance.scopesCheckedAt && instance.scopes === null) ||
      (instance.version && belowMinimum(instance.version)),
  )

export function refreshInstanceMeta(ctx: Ctx, instance: Pick<Instance, "id">) {
  return oneAtATime(`meta:${instance.id}`, () => refreshInstanceMetaNow(ctx, instance.id))
}

async function refreshInstanceMetaNow(ctx: Ctx, id: string): Promise<Instance | undefined> {
  const [instance] = await ctx.db.select().from(instances).where(eq(instances.id, id))
  if (!instance?.apiKeyEnc) return instance
  const client = clientFor(ctx, instance)
  const [version, scopes] = await Promise.all([
    versionFromInside(instance) ? Promise.resolve(null) : client.version(instance.metricsUrl),
    client.discoverScopes(),
  ])
  if (version) {
    await ctx.db.transaction(async (tx) => {
      const [now] = await tx.select().from(instances).where(eq(instances.id, instance.id)).for("update")
      if (!now || now.collectionRevision !== instance.collectionRevision || versionFromInside(now)) return
      await tx.update(instances).set({ version }).where(eq(instances.id, instance.id))
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

export function executionUrl(instance: Pick<Instance, "baseUrl">, workflowId: string, executionId: string) {
  return `${instance.baseUrl.replace(/\/+$/, "")}/workflow/${encodeURIComponent(workflowId)}/executions/${encodeURIComponent(executionId)}`
}

export function workflowUrl(instance: Pick<Instance, "baseUrl">, workflowId: string) {
  return `${instance.baseUrl.replace(/\/+$/, "")}/workflow/${encodeURIComponent(workflowId)}`
}

const RELEASE_RETRY_MS = 3600_000

export function releaseChecker(fetchImpl: FetchLike = (url, init) => fetch(url, init), now = () => Date.now()) {
  let known: string | null = null
  let checkedAt = 0
  let failed = false
  let reading: Promise<string | null> | null = null
  const read = async () => {
    try {
      const res = await fetchImpl("https://api.github.com/repos/n8n-io/n8n/releases/latest", {
        headers: { accept: "application/vnd.github+json", "user-agent": "n8n-ops" },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
      const tag = ((await res.json()) as { tag_name?: unknown }).tag_name
      if (typeof tag !== "string" || !tag) throw new Error("GitHub gave no release tag")
      known = tag.replace(/^n8n@/, "")
      failed = false
    } catch {
      failed = true
    }
    checkedAt = now()
    return known
  }
  return (everyHours: number): Promise<string | null> => {
    const every = everyHours * 3600_000
    const wait = failed ? Math.min(every, RELEASE_RETRY_MS) : every
    if (checkedAt && now() - checkedAt < wait) return Promise.resolve(known)
    reading ??= read().finally(() => {
      reading = null
    })
    return reading
  }
}

const latestRelease = releaseChecker()

export async function latestN8nVersion(ctx: Pick<Ctx, "settings">): Promise<string | null> {
  return latestRelease((await ctx.settings.get("general")).releaseCheckHours)
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  return 0
}

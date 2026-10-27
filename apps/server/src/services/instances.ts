import { readScopes, writeScopes } from "@n8n-ops/shared"
import { eq } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { instances } from "../db/schema.ts"
import { oneAtATime } from "../lib/one-at-a-time.ts"
import { N8nClient } from "../n8n/client.ts"

export type Instance = typeof instances.$inferSelect

export function clientFor(ctx: Ctx, instance: Instance): N8nClient {
  return new N8nClient(instance.baseUrl, ctx.secrets.decrypt(instance.apiKeyEnc))
}

/** The turn an instance's health reports, its version writes and its changes take, one at a time. */
export const healthTurn = (instanceId: string) => `health:${instanceId}`

/** Whether the version comes from the worker reading inside: checked from inside, and the last report had one. */
export function versionFromInside(
  instance: Pick<Instance, "collection" | "workerId" | "containerName" | "healthDetail">,
) {
  const detail = instance.healthDetail as { source?: string; version?: string } | null
  return readsInside(instance) && detail?.source === "inside" && Boolean(detail.version)
}

/** Whether the worker on the host reads the instance from inside its main container. */
export function readsInside(instance: Pick<Instance, "collection" | "workerId" | "containerName">) {
  return instance.collection === "worker" && Boolean(instance.workerId) && Boolean(instance.containerName)
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
  const targetChanged = differs("collection") || differs("workerId") || differs("containerName")
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

/** The scopes n8n-ops may rely on: discovered from n8n, or declared by the operator on older versions. */
export function effectiveScopes(instance: Pick<Instance, "scopes" | "scopesSource" | "declaredAccess">): string[] {
  if (instance.scopesSource === "declared") return instance.declaredAccess === "write" ? writeScopes : readScopes
  return instance.scopes ?? []
}

/** Reads the n8n version and the API key's scopes, and stores them. */
export function refreshInstanceMeta(ctx: Ctx, instance: Instance) {
  // One at a time per instance, so a slow earlier read never writes over a later one.
  return oneAtATime(`meta:${instance.id}`, () => refreshInstanceMetaNow(ctx, instance))
}

async function refreshInstanceMetaNow(ctx: Ctx, instance: Instance) {
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
  const patch = {
    scopes,
    scopesSource: scopes === null ? ("declared" as const) : ("discovered" as const),
    declaredAccess: scopes === null ? (instance.declaredAccess ?? "read") : instance.declaredAccess,
    scopesCheckedAt: new Date(),
    updatedAt: new Date(),
  }
  await ctx.db.update(instances).set(patch).where(eq(instances.id, instance.id))
  const after = effectiveScopes({ ...instance, ...patch })
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
  return { ...instance, ...patch, version: version ?? instance.version }
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

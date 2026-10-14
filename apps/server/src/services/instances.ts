import { readScopes, writeScopes } from "@n8n-ops/shared"
import { eq } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { instances } from "../db/schema.ts"
import { N8nClient } from "../n8n/client.ts"

export type Instance = typeof instances.$inferSelect

export function clientFor(ctx: Ctx, instance: Instance): N8nClient {
  return new N8nClient(instance.baseUrl, ctx.secrets.decrypt(instance.apiKeyEnc))
}

/** The scopes n8n-ops may rely on: discovered from n8n, or declared by the operator on older versions. */
export function effectiveScopes(instance: Pick<Instance, "scopes" | "scopesSource" | "declaredAccess">): string[] {
  if (instance.scopesSource === "declared") return instance.declaredAccess === "write" ? writeScopes : readScopes
  return instance.scopes ?? []
}

/** Reads the n8n version and the API key's scopes, and stores them. */
export async function refreshInstanceMeta(ctx: Ctx, instance: Instance) {
  const client = clientFor(ctx, instance)
  const [version, scopes] = await Promise.all([client.version(), client.discoverScopes()])
  const before = new Set(effectiveScopes(instance))
  const patch = {
    version: version ?? instance.version,
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
  return { ...instance, ...patch }
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

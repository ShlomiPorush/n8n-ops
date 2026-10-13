import { type Health, healthSchema } from "@n8n-ops/shared"

export type HealthView = { label: string; tone: "ok" | "error" | "pending" }

export function describeHealth(health: Health | null | "unreachable"): HealthView {
  if (health === null) return { label: "Checking server…", tone: "pending" }
  if (health === "unreachable") return { label: "Server unreachable", tone: "error" }
  return health.status === "ok"
    ? { label: "Server ready", tone: "ok" }
    : { label: "Server not ready: database unavailable", tone: "error" }
}

export async function fetchHealth(): Promise<Health | "unreachable"> {
  try {
    const res = await fetch("/healthz/ready")
    return healthSchema.parse(await res.json())
  } catch {
    return "unreachable"
  }
}

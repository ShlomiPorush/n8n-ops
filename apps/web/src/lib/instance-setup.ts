import {
  apiScopesOf,
  type BackupVia,
  type CapabilityKey,
  capabilityLabels,
  type Requirements,
  withDependencies,
  withoutDependents,
} from "@n8n-ops/shared"

type CollectionMode = "direct" | "worker"

export type CheckState = "ok" | "failed" | "running" | "stale" | "missing"

export type CheckView = {
  state: CheckState
  current: boolean
  ok: boolean
  reason: string | null
  attempt: number | null
  startedAt: string | null
  at: string | null
  detail: Record<string, unknown> | null
}

export type SetupData = {
  id: string
  name: string
  setupState: "incomplete" | "complete"
  baseUrl: string
  collection: CollectionMode
  backupVia: BackupVia
  workerId: string | null
  hasApiKey: boolean
  chosen: CapabilityKey[]
  verify: CapabilityKey[]
  after: CapabilityKey[]
  requirements: Requirements
  checks: Record<"api" | "health" | "worker" | "backup" | "access", CheckView | null>
  ready: boolean
}

export type StepKey = "basics" | "api" | "worker" | "health" | "access" | "backup" | "review"

export const stepTitles: Record<StepKey, string> = {
  basics: "Basics",
  api: "API Key",
  worker: "Host Worker",
  health: "Health",
  access: "Temporary Access",
  backup: "Backup",
  review: "Review",
}

export function stepCheck(setup: SetupData, step: StepKey): CheckView | null {
  switch (step) {
    case "api":
      return setup.checks.api
    case "worker":
      return setup.checks.worker
    case "health":
      return setup.requirements.health ? setup.checks.health : setup.checks.worker
    case "access":
      return setup.checks.access
    case "backup":
      return setup.checks.backup
    default:
      return null
  }
}

export function neededSteps(r: Requirements): StepKey[] {
  const steps: StepKey[] = []
  if (r.api) steps.push("api")
  if (r.worker) steps.push("worker")
  if (r.health || r.worker?.healthy) steps.push("health")
  if (r.access) steps.push("access")
  if (r.backup) steps.push("backup")
  return steps
}

export function stepsOf(setup: SetupData, keep: Iterable<StepKey> = []): StepKey[] {
  const kept = new Set(keep)
  const needed = neededSteps(setup.requirements)
  const shown = setup.setupState === "complete" ? needed.filter((s) => !stepCheck(setup, s)?.ok || kept.has(s)) : needed
  return ["basics", ...shown, "review"]
}

export function firstOpenStep(setup: SetupData, steps: StepKey[]): StepKey {
  return steps.find((s) => s !== "basics" && s !== "review" && !stepCheck(setup, s)?.ok) ?? "review"
}

export type StepMark = "done" | "attention" | "running" | "todo"

export function stepMark(setup: SetupData | null, step: StepKey): StepMark {
  if (step === "basics") return setup ? "done" : "todo"
  if (!setup || step === "review") return "todo"
  const check = stepCheck(setup, step)
  if (!check || check.state === "missing") return "todo"
  if (step === "access") return check.ok ? "done" : "todo"
  if (check.ok) return "done"
  if (check.state === "running") return "running"
  return "attention"
}

export type Selection = { chosen: CapabilityKey[]; collection: CollectionMode; backupVia: BackupVia }

export function toggle(chosen: CapabilityKey[], key: CapabilityKey, on: boolean): CapabilityKey[] {
  return on ? withDependencies([...chosen, key]) : withoutDependents(chosen, [key])
}

export function badgesOf(key: CapabilityKey, s: Pick<Selection, "collection" | "backupVia">) {
  const badges: ("API key" | "Worker")[] = []
  if (apiScopesOf(key, s.backupVia)) badges.push("API key")
  if ((key === "health" && s.collection === "worker") || (key === "backup" && s.backupVia === "worker"))
    badges.push("Worker")
  return badges
}

export function scopeHint(r: Requirements) {
  const lines = Object.entries(r.api?.scopes ?? {}).map(([k, scopes]) => ({
    key: k as CapabilityKey,
    label: capabilityLabels[k as CapabilityKey],
    scopes,
  }))
  const all = [...new Set(lines.flatMap((l) => l.scopes))].sort()
  return { lines, all }
}

export function parseAdd(raw: string | null, known: readonly CapabilityKey[]): CapabilityKey[] {
  if (!raw) return []
  const asked = new Set(raw.split(",").map((s) => s.trim()))
  return known.filter((k) => asked.has(k))
}

export type PickedInstance = {
  id: string
  name: string
  setupState: "incomplete" | "complete"
  chosen: CapabilityKey[]
}

export function activeWith<T extends PickedInstance>(list: T[] | undefined, key: CapabilityKey): T[] {
  return (list ?? []).filter((i) => i.setupState === "complete" && i.chosen.includes(key))
}

export function waitingForWorker(setup: SetupData | undefined) {
  return setup?.checks.worker?.state === "running"
}

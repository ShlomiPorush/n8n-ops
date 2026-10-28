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

/*
 * The instance setup (docs/adr/0002) as the page draws it. Which steps show and how each stands come from the
 * server's answer to GET /instances/:id/setup, never from what the page remembers, so a reload or another tab
 * shows the same.
 */

export type CheckState = "ok" | "failed" | "running" | "stale" | "missing"

/** One requirement with its last check, as GET /instances/:id/setup reports it. */
export type CheckView = {
  state: CheckState
  /** The result is about the configuration as it is now. */
  current: boolean
  ok: boolean
  reason: string | null
  attempt: number | null
  startedAt: string | null
  at: string | null
  deadline: string | null
  detail: Record<string, unknown> | null
}

export type SetupData = {
  id: string
  name: string
  setupState: "incomplete" | "complete"
  configRevision: number
  baseUrl: string
  collection: CollectionMode
  backupVia: BackupVia
  workerId: string | null
  hasApiKey: boolean
  /** The stored selection; for an active instance, its active capabilities. */
  chosen: CapabilityKey[]
  /** What activation verifies: for an active instance only what is added. */
  verify: CapabilityKey[]
  /** The selection after activation. */
  after: CapabilityKey[]
  requirements: Requirements
  checks: Record<"api" | "health" | "worker" | "backup" | "access", CheckView | null>
  ready: boolean
  deadlineMs: number
  freshMs: number
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

/** The check a step proves. Health through the worker is the worker check, which then needs a healthy main. */
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

/** The steps the selection needs, in the order they are taken, without Basics and Review. */
export function neededSteps(r: Requirements): StepKey[] {
  const steps: StepKey[] = []
  if (r.api) steps.push("api")
  if (r.worker) steps.push("worker")
  if (r.health || r.worker?.healthy) steps.push("health")
  if (r.access) steps.push("access")
  if (r.backup) steps.push("backup")
  return steps
}

/**
 * The steps on the rail. A draft shows every step its selection needs. An active instance that adds a capability
 * shows only the steps whose check is not current and passing, plus the one open and those already taken on this
 * page, so a step never disappears while it is being taken.
 */
export function stepsOf(setup: SetupData, keep: Iterable<StepKey> = []): StepKey[] {
  const kept = new Set(keep)
  const needed = neededSteps(setup.requirements)
  const shown = setup.setupState === "complete" ? needed.filter((s) => !stepCheck(setup, s)?.ok || kept.has(s)) : needed
  return ["basics", ...shown, "review"]
}

/** Where to continue a setup: the first step whose check does not pass yet, else the review. */
export function firstOpenStep(setup: SetupData, steps: StepKey[]): StepKey {
  return steps.find((s) => s !== "basics" && s !== "review" && !stepCheck(setup, s)?.ok) ?? "review"
}

/** How a step stands on the rail. */
export type StepMark = "done" | "attention" | "running" | "todo"

export function stepMark(setup: SetupData | null, step: StepKey): StepMark {
  if (step === "basics") return setup ? "done" : "todo"
  if (!setup || step === "review") return "todo"
  const check = stepCheck(setup, step)
  if (!check || check.state === "missing") return "todo"
  if (check.ok) return "done"
  if (check.state === "running") return "running"
  return "attention"
}

/** What a selection chooses on the first step: the capabilities and where health and backups come from. */
export type Selection = { chosen: CapabilityKey[]; collection: CollectionMode; backupVia: BackupVia }

/** Turns a capability on or off. Moving needs the map and restoring needs backups, so they come and go with them. */
export function toggle(chosen: CapabilityKey[], key: CapabilityKey, on: boolean): CapabilityKey[] {
  return on ? withDependencies([...chosen, key]) : withoutDependents(chosen, [key])
}

/** What a capability needs besides itself, as badges on its card: the API key, the worker on the host. */
export function badgesOf(key: CapabilityKey, s: Pick<Selection, "collection" | "backupVia">) {
  const badges: ("API key" | "Worker")[] = []
  if (apiScopesOf(key, s.backupVia)) badges.push("API key")
  if ((key === "health" && s.collection === "worker") || (key === "backup" && s.backupVia === "worker"))
    badges.push("Worker")
  return badges
}

/**
 * The scopes the API key needs, per chosen capability, for the hint on the API step. Temporary access needs no
 * scope of its own; it grants among those the key holds.
 */
export function scopeHint(r: Requirements) {
  const lines = Object.entries(r.api?.scopes ?? {}).map(([k, scopes]) => ({
    key: k as CapabilityKey,
    label: capabilityLabels[k as CapabilityKey],
    scopes,
  }))
  const all = [...new Set(lines.flatMap((l) => l.scopes))].sort()
  return { lines, all }
}

/** The add list of an active instance's setup page (`?add=move,restore`); only known capabilities, in order. */
export function parseAdd(raw: string | null, known: readonly CapabilityKey[]): CapabilityKey[] {
  if (!raw) return []
  const asked = new Set(raw.split(",").map((s) => s.trim()))
  return known.filter((k) => asked.has(k))
}

/** An instance as a page that picks one for an action reads it from GET /instances. */
export type PickedInstance = {
  id: string
  name: string
  setupState: "incomplete" | "complete"
  chosen: CapabilityKey[]
}

/** The instances an action of a capability may pick: active, with that capability chosen. */
export function activeWith<T extends PickedInstance>(list: T[] | undefined, key: CapabilityKey): T[] {
  return (list ?? []).filter((i) => i.setupState === "complete" && i.chosen.includes(key))
}

/** Whether a worker check is still waiting for the worker, so the page asks again in a moment. */
export function waitingForWorker(setup: SetupData | undefined, now = Date.now()) {
  const check = setup?.checks.worker
  if (check?.state !== "running") return false
  return !check.deadline || Date.parse(check.deadline) + 5_000 > now
}

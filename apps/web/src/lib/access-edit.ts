import { addEntries } from "@/lib/entries"

/*
 * Access requests that cover several instances: how the list names them, what each instance says about what
 * changed since the agent asked, and the approval editor's state, checks and the body Approve sends.
 */

export type AccessDropReason = "closed" | "deleted" | "no_scopes"

/** One instance of an access request, as the server sends it. */
export type AccessInstance = {
  position: number
  instanceId: string | null
  name: string
  /** The instance was deleted from n8n-ops; it can no longer be granted. */
  deleted: boolean
  /** False when an approver added it. */
  requested: boolean
  requestedScopes: string[] | null
  requestedWorkflowIds: string[] | null
  scopes: string[]
  /** Empty: the whole instance. */
  workflowIds: string[]
  workflowNames: Record<string, string>
  included: boolean
  droppedReason: AccessDropReason | null
  droppedScopes: string[]
}

/** What the editor may offer while a request waits: scopes per instance on it, and other instances open to agents. */
export type EditorChoices = {
  grantable: Record<string, string[]>
  others: { instanceId: string; name: string; scopes: string[] }[]
}

/** In the order the agent named them, approvers' additions after. */
export const byPosition = (list: AccessInstance[]) => [...list].sort((a, b) => a.position - b.position)

/** Whether an instance is granted (or would be by approving the draft as it stands). */
export const isGranted = (i: Pick<AccessInstance, "included" | "droppedReason">) => i.included && !i.droppedReason

/** "a", "a and b", "a, b and c". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

/** A few names in little room: the first, and "+N" for the others. */
export function shortNames(names: string[]): string {
  if (!names.length) return "no instance"
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : (names[0] as string)
}

/** The instances the agent asked for, in its order; every instance when none is marked (an older request). */
export function askedNames(instances: AccessInstance[]): string[] {
  const sorted = byPosition(instances)
  const asked = sorted.filter((i) => i.requested)
  return (asked.length ? asked : sorted).map((i) => i.name)
}

/** How a request is named in lists and toasts: the first instance asked for, and "+N" for the others asked for. */
export const instanceLabel = (instances: AccessInstance[]) => shortNames(askedNames(instances))

/** The names of the instances granted (or that approving the draft would grant). */
export const grantedNames = (instances: AccessInstance[]) =>
  byPosition(instances)
    .filter((i) => isGranted(i))
    .map((i) => i.name)

const nameOf = (i: Pick<AccessInstance, "workflowNames">, id: string) =>
  Object.hasOwn(i.workflowNames ?? {}, id) ? i.workflowNames[id] : undefined

/** A workflow by its name when known, by its ID otherwise. */
export const workflowLabel = (i: Pick<AccessInstance, "workflowNames">, id: string) => nameOf(i, id) ?? id

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && new Set([...a, ...b]).size === a.length

const dropText: Record<AccessDropReason, string> = {
  closed: "Left out: closed to agents",
  deleted: "Left out: the instance was deleted",
  no_scopes: "Left out: it allows none of these scopes any more",
}

/** What differs on one instance from what the agent asked for, one short line each. */
export function instanceNotes(i: AccessInstance): string[] {
  const notes: string[] = []
  if (!i.requested) notes.push("Added by an approver; the agent did not ask for it.")
  if (i.droppedReason) notes.push(`${dropText[i.droppedReason]}.`)
  else if (!i.included) notes.push(i.requested ? "Left out by an approver." : "Left out.")
  if (i.droppedScopes.length) notes.push(`Not granted, no longer allowed: ${i.droppedScopes.join(", ")}.`)
  if (i.requested && i.requestedScopes && !sameSet(i.requestedScopes, i.scopes))
    notes.push(`The agent asked for: ${i.requestedScopes.join(", ") || "no scopes"}.`)
  if (i.requested && i.requestedWorkflowIds && !sameSet(i.requestedWorkflowIds, i.workflowIds))
    notes.push(
      i.requestedWorkflowIds.length
        ? `The agent asked for only these workflows: ${i.requestedWorkflowIds.map((w) => workflowLabel(i, w)).join(", ")}.`
        : "The agent asked for the whole instance.",
    )
  return notes
}

// --- The approval editor

/** One instance in the editor. `whole` is null until the approver chooses (an added instance starts so). */
export type EditInstance = {
  instanceId: string
  name: string
  /** Added by the approver in this editor. */
  added: boolean
  included: boolean
  scopes: string[]
  whole: boolean | null
  workflowIds: string[]
  /** A workflow ID typed in the Add field and not yet a chip; it counts as added. */
  pending: string
}

export type EditState = { minutes: string; instances: EditInstance[] }

/** The scopes an instance on the request may be granted now; none when it is closed or unknown. */
export const grantableOf = (editor: EditorChoices | undefined, instanceId: string) =>
  editor?.grantable[instanceId] ?? []

/**
 * The editor as the draft stands: what approving without changes would grant. An instance that may be granted
 * nothing now starts left out, as the server leaves it out then; scopes no longer allowed are not selected.
 */
export function initialEdit(
  r: { minutes: number; instances: AccessInstance[] },
  editor: EditorChoices | undefined,
): EditState {
  return {
    minutes: String(r.minutes),
    instances: byPosition(r.instances).flatMap((i) => {
      if (i.deleted || !i.instanceId) return []
      const grantable = grantableOf(editor, i.instanceId)
      return [
        {
          instanceId: i.instanceId,
          name: i.name,
          added: false,
          included: i.included && grantable.length > 0,
          scopes: i.scopes.filter((s) => grantable.includes(s)),
          whole: i.workflowIds.length === 0,
          workflowIds: [...i.workflowIds],
          pending: "",
        },
      ]
    }),
  }
}

/** Adds an instance open to agents: included, with no scope and no choice of workflows yet, so the approver chooses. */
export function addInstance(state: EditState, other: { instanceId: string; name: string }): EditState {
  if (state.instances.some((i) => i.instanceId === other.instanceId)) return state
  return {
    ...state,
    instances: [
      ...state.instances,
      {
        instanceId: other.instanceId,
        name: other.name,
        added: true,
        included: true,
        scopes: [],
        whole: null,
        workflowIds: [],
        pending: "",
      },
    ],
  }
}

/** The workflow IDs an instance will be sent with: the chips and what is typed but not yet a chip. */
export const workflowsOf = (i: EditInstance) =>
  i.pending.trim() ? addEntries(i.workflowIds, i.pending) : i.workflowIds

/** The minutes typed, when they are a whole number; NaN otherwise. */
export function minutesOf(state: EditState): number {
  const text = state.minutes.trim()
  return /^\d+$/.test(text) ? Number(text) : Number.NaN
}

/** Why Approve cannot be pressed yet, in a short sentence; null when it can. */
export function editProblem(state: EditState, maxMinutes?: number): string | null {
  const included = state.instances.filter((i) => i.included)
  if (!included.length) return "Include at least one instance."
  for (const i of included) {
    if (!i.scopes.length) return `Choose at least one scope for ${i.name}.`
    if (i.whole === null) return `Choose the whole instance or only some workflows for ${i.name}.`
    if (!i.whole && !workflowsOf(i).length) return `Add a workflow for ${i.name}, or choose the whole instance.`
  }
  const minutes = minutesOf(state)
  if (!Number.isInteger(minutes) || minutes < 1 || (maxMinutes !== undefined && minutes > maxMinutes))
    return maxMinutes !== undefined ? `Grant 1 to ${maxMinutes} minutes.` : "Grant at least 1 minute."
  return null
}

/** Whether the approver changed anything from the draft the editor started from. */
export function editChanged(state: EditState, base: EditState): boolean {
  if (minutesOf(state) !== minutesOf(base)) return true
  if (state.instances.length !== base.instances.length) return true
  return state.instances.some((i) => {
    const b = base.instances.find((x) => x.instanceId === i.instanceId)
    if (!b || i.added) return true
    if (i.included !== b.included) return true
    if (!i.included) return false
    if (!sameSet(i.scopes, b.scopes) || i.whole !== b.whole) return true
    return !i.whole && !sameSet(workflowsOf(i), b.workflowIds)
  })
}

export type ApproveBody = {
  revision: number
  edit?: {
    minutes: number
    instances: {
      instanceId: string
      included: boolean
      scopes: string[]
      allWorkflows: boolean
      workflowIds: string[]
    }[]
  }
}

/**
 * The body of Approve: the revision the editor started from, and every instance as the editor shows it, included
 * or left out, with the minutes. Always the selection on screen, never the stored draft: an instance's policy can
 * change without changing the request, and the person approves what they see (the server still applies the policy
 * as it is then).
 */
export function approveBody(revision: number, state: EditState): ApproveBody {
  return {
    revision,
    edit: {
      minutes: minutesOf(state),
      instances: state.instances.map((i) => ({
        instanceId: i.instanceId,
        included: i.included,
        scopes: [...i.scopes],
        allWorkflows: i.whole !== false,
        workflowIds: i.whole === false ? [...workflowsOf(i)] : [],
      })),
    },
  }
}

import { addEntries } from "@/lib/entries"

export type AccessDropReason = "closed" | "deleted" | "no_scopes"

export type AccessInstance = {
  position: number
  instanceId: string | null
  name: string
  deleted: boolean
  requested: boolean
  requestedScopes: string[] | null
  requestedWorkflowIds: string[] | null
  scopes: string[]
  workflowIds: string[]
  workflowNames: Record<string, string>
  included: boolean
  droppedReason: AccessDropReason | null
  droppedScopes: string[]
}

export type EditorChoices = {
  grantable: Record<string, string[]>
  others: { instanceId: string; name: string; scopes: string[] }[]
}

export const byPosition = (list: AccessInstance[]) => [...list].sort((a, b) => a.position - b.position)

export const isGranted = (i: Pick<AccessInstance, "included" | "droppedReason">) => i.included && !i.droppedReason

export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

export function shortNames(names: string[]): string {
  if (!names.length) return "no instance"
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : (names[0] as string)
}

export function askedNames(instances: AccessInstance[]): string[] {
  const sorted = byPosition(instances)
  const asked = sorted.filter((i) => i.requested)
  return (asked.length ? asked : sorted).map((i) => i.name)
}

export const instanceLabel = (instances: AccessInstance[]) => shortNames(askedNames(instances))

export const grantedNames = (instances: AccessInstance[]) =>
  byPosition(instances)
    .filter((i) => isGranted(i))
    .map((i) => i.name)

const nameOf = (i: Pick<AccessInstance, "workflowNames">, id: string) =>
  Object.hasOwn(i.workflowNames ?? {}, id) ? i.workflowNames[id] : undefined

export const workflowLabel = (i: Pick<AccessInstance, "workflowNames">, id: string) => nameOf(i, id) ?? id

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && new Set([...a, ...b]).size === a.length

const dropText: Record<AccessDropReason, string> = {
  closed: "Left out: closed to agents",
  deleted: "Left out: the instance was deleted",
  no_scopes: "Left out: it allows none of these scopes any more",
}

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

export type EditInstance = {
  instanceId: string
  name: string
  added: boolean
  included: boolean
  scopes: string[]
  whole: boolean | null
  workflowIds: string[]
  pending: string
}

export type EditState = { minutes: string; instances: EditInstance[] }

export const grantableOf = (editor: EditorChoices | undefined, instanceId: string) =>
  editor?.grantable[instanceId] ?? []

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

export const offeredScopes = (editor: EditorChoices | undefined, i: Pick<EditInstance, "instanceId" | "added">) =>
  i.added
    ? (editor?.others.find((o) => o.instanceId === i.instanceId)?.scopes ?? [])
    : grantableOf(editor, i.instanceId)

export function onScreen(state: EditState, editor: EditorChoices | undefined): EditState {
  return {
    ...state,
    instances: state.instances.map((i) => {
      const offered = offeredScopes(editor, i)
      return { ...i, included: i.included && offered.length > 0, scopes: i.scopes.filter((s) => offered.includes(s)) }
    }),
  }
}

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

export const workflowsOf = (i: EditInstance) =>
  i.pending.trim() ? addEntries(i.workflowIds, i.pending) : i.workflowIds

export function minutesOf(state: EditState): number {
  const text = state.minutes.trim()
  return /^\d+$/.test(text) ? Number(text) : Number.NaN
}

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

import { api, refreshAreas, useApiMutation } from "@/lib/api"
import { toast } from "@/lib/toast"
import { offerUndo } from "@/lib/undo"

export type ProblemAction = "resolve" | "mute" | "reopen" | "unmute"

/** A problem action's answer: a receipt for Undo, or `changed: false` when everything was already there. */
type ActionAnswer = { ok: true; changed: boolean; receipt?: { id: string } }

/** The words of each problem action: its result (FB-4), its failure (FB-3), and its Undo (FB-16). */
const actionWords: Record<
  ProblemAction,
  { done: string; already: string; failed: string; undoing: string; undone: string }
> = {
  resolve: {
    done: "Problem resolved",
    already: "Already resolved",
    failed: "resolve",
    undoing: "resolving",
    undone: "Resolve undone",
  },
  mute: {
    done: "Muted for 24 hours",
    already: "Already muted",
    failed: "mute",
    undoing: "muting",
    undone: "Mute undone",
  },
  reopen: {
    done: "Problem reopened",
    already: "Already open",
    failed: "reopen",
    undoing: "reopening",
    undone: "Reopen undone",
  },
  unmute: {
    done: "Problem unmuted",
    already: "Not muted",
    failed: "unmute",
    undoing: "unmuting",
    undone: "Unmute undone",
  },
}

/**
 * Resolve, Mute 24 h, Reopen and Unmute act at once, without asking, and their toast offers Undo by the receipt the
 * server answered with (FB-16, DS-20). An action another tab already did says so, with nothing to undo. Lists,
 * the pane, Overview and Needs attention refresh after the action and after its Undo, and an answer read before
 * either is dropped (`refreshAreas`); when they cannot refresh after an Undo, its message offers Refresh. Used by
 * the problem's pane and by the rows of Needs attention. With `workflow`, the action is on that Affected workflow of
 * the Problem only; without, on every workflow of the Problem.
 */
export function useProblemAction(id: string, action: ProblemAction, named: () => string, workflow?: string) {
  const words = actionWords[action]
  const path = `/problems/${id}${workflow ? `/workflows/${workflow}` : ""}/${action}`
  const mutation = useApiMutation<{ hours: number } | undefined, ActionAnswer>("POST", path, {
    failed: () => `${words.failed} ${named()}`,
  })
  return async () => {
    const answer = await mutation.mutateAsync(action === "mute" ? { hours: 24 } : undefined)
    const refresh = () => refreshAreas("/problems", "/overview")
    // The action's message carries Undo; a list that could not refresh says so itself (TB-5).
    refresh().catch(() => {})
    const name = named()
    const receipt = answer.receipt
    if (!answer.changed || !receipt) {
      toast.info(`${words.already}: ${name}`)
      return
    }
    offerUndo({
      message: `${words.done}: ${name}`,
      ariaLabel: `Undo ${words.undoing} ${name}`,
      name,
      undone: `${words.undone}: ${name}`,
      undo: () => api(`/problems/${id}/undo/${receipt.id}`, { method: "POST" }),
      after: refresh,
    })
  }
}

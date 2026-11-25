import { api, refreshAreas, useApiMutation } from "@/lib/api"
import { toast } from "@/lib/toast"
import { offerUndo } from "@/lib/undo"

export type ProblemAction = "resolve" | "mute" | "reopen" | "unmute"

type ActionAnswer = { ok: true; changed: boolean; receipt?: { id: string } }

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

export function useProblemAction(id: string, action: ProblemAction, named: () => string, workflow?: string) {
  const words = actionWords[action]
  const path = `/problems/${id}${workflow ? `/workflows/${workflow}` : ""}/${action}`
  const mutation = useApiMutation<{ hours: number } | undefined, ActionAnswer>("POST", path, {
    failed: () => `${words.failed} ${named()}`,
  })
  return async () => {
    const answer = await mutation.mutateAsync(action === "mute" ? { hours: 24 } : undefined)
    const refresh = () => refreshAreas("/problems", "/overview")
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

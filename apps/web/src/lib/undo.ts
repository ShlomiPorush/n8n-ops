import { ApiError, failureText } from "@/lib/api"
import { UNDO_MS } from "@/lib/behavior"
import { sessionEnding } from "@/lib/session"
import { toast } from "@/lib/toast"

const REFRESH_FAILED_TEXT = "Could not refresh the list."

export type UndoOffer = {
  message: string
  ariaLabel: string
  name: string
  undone: string
  undo: () => Promise<unknown>
  after?: () => Promise<unknown>
}

export function undoRefusal(code: string, name: string): { tone: "info" | "warning"; text: string } | undefined {
  switch (code) {
    case "already_changed":
      return { tone: "warning", text: `Already changed: ${name} was changed after this, so nothing was undone.` }
    case "receipt_used":
      return { tone: "info", text: `Already undone: ${name}` }
    case "receipt_expired":
    case "receipt_not_found":
      return { tone: "warning", text: `Too late to undo: ${name} was left as it is.` }
    default:
      return undefined
  }
}

export function offerUndo(offer: UndoOffer) {
  toast.success(offer.message, {
    duration: UNDO_MS,
    action: { label: "Undo", ariaLabel: offer.ariaLabel, run: () => runUndo(offer) },
  })
}

async function runUndo(offer: UndoOffer): Promise<void> {
  try {
    await offer.undo()
  } catch (error) {
    const refused = error instanceof ApiError ? undoRefusal(error.code, offer.name) : undefined
    if (refused) toast[refused.tone](refused.text)
    else if (!sessionEnding())
      toast.error(failureText("undo", error), {
        duration: Number.POSITIVE_INFINITY,
        action: { label: "Retry", ariaLabel: `Retry: ${offer.ariaLabel}`, run: () => runUndo(offer) },
      })
    offer.after?.().catch(() => {})
    return
  }
  try {
    await offer.after?.()
    toast.success(offer.undone)
  } catch {
    if (!sessionEnding()) offerRefresh(offer)
  }
}

function offerRefresh(offer: UndoOffer) {
  toast.success(`${offer.undone}. ${REFRESH_FAILED_TEXT}`, {
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: "Refresh",
      run: () =>
        offer.after?.().catch(() => {
          if (!sessionEnding()) offerRefresh(offer)
        }),
    },
  })
}

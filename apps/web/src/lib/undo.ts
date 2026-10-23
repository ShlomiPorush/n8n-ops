import { ApiError, failureText } from "@/lib/api"
import { UNDO_MS } from "@/lib/behavior"
import { sessionEnding } from "@/lib/session"
import { toast } from "@/lib/toast"

/*
 * Act at once, offer Undo (FB-16). The action has run and the server answered with a receipt; its success toast
 * offers Undo for UNDO_MS, longer while the pointer or the keyboard is on it (FB-2). Undo sends the receipt back;
 * while it runs the toast stays and its button is locked, and the toast that follows takes over:
 * - done: "<what> undone: <name>";
 * - refused, because the object changed since, the receipt was used or is too old: says so, nothing changed;
 * - failed (network, server): "Could not undo: <reason>" with Retry until closed.
 * Whatever the outcome, `after` refreshes what shows the object.
 */

export type UndoOffer = {
  /** The success toast of the action: "Problem resolved: Sync orders". */
  message: string
  /** Names what Undo restores, for the keyboard and screen readers: "Undo resolving Sync orders". */
  ariaLabel: string
  /** The object's name, for the refusals. */
  name: string
  /** The toast once undone: "Resolve undone: Sync orders". */
  undone: string
  /** Sends the receipt back. */
  undo: () => Promise<unknown>
  /** Refreshes the lists and panes that show the object. */
  after?: () => void
}

/** What a refused Undo says, by the server's code; undefined for a failure worth retrying. */
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
    toast.success(offer.undone)
  } catch (error) {
    const refused = error instanceof ApiError ? undoRefusal(error.code, offer.name) : undefined
    if (refused) toast[refused.tone](refused.text)
    // On the way to sign-in after the session ended, no error toast is shown (NL-18).
    else if (!sessionEnding())
      toast.error(failureText("undo", error), {
        duration: Number.POSITIVE_INFINITY,
        action: { label: "Retry", ariaLabel: `Retry: ${offer.ariaLabel}`, run: () => runUndo(offer) },
      })
  } finally {
    offer.after?.()
  }
}

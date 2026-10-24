import { ApiError, failureText } from "@/lib/api"
import { UNDO_MS } from "@/lib/behavior"
import { sessionEnding } from "@/lib/session"
import { toast } from "@/lib/toast"

/*
 * Act at once, offer Undo (FB-16). The action has run and the server answered with a receipt; its success toast
 * offers Undo for UNDO_MS, longer while the pointer or the keyboard is on it (FB-2). Undo sends the receipt back;
 * while it runs the toast stays and its button is locked, and the toast that follows takes over:
 * - done: `after` refreshes what shows the object, then "<what> undone: <name>"; when that refresh fails, the same
 *   text says the list did not refresh and offers Refresh until closed, which reads again and never resends Undo;
 * - refused, because the object changed since, the receipt was used or is too old: says so, nothing changed;
 * - failed (network, server): "Could not undo: <reason>" with Retry until closed.
 * After a refusal or a failure `after` refreshes too, without holding the message.
 */

/** Added to the undone text when the lists could not be read again. */
const REFRESH_FAILED_TEXT = "Could not refresh the list."

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
  /** Refreshes the lists and panes that show the object; rejects when one of them could not be read again. */
  after?: () => Promise<unknown>
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
  } catch (error) {
    const refused = error instanceof ApiError ? undoRefusal(error.code, offer.name) : undefined
    if (refused) toast[refused.tone](refused.text)
    // On the way to sign-in after the session ended, no error toast is shown (NL-18).
    else if (!sessionEnding())
      toast.error(failureText("undo", error), {
        duration: Number.POSITIVE_INFINITY,
        action: { label: "Retry", ariaLabel: `Retry: ${offer.ariaLabel}`, run: () => runUndo(offer) },
      })
    // The page shows a refresh that failed here itself (TB-5); the message stays about the Undo.
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

/** Undone, but the lists still show the old state: Refresh reads them again, without sending Undo again. */
function offerRefresh(offer: UndoOffer) {
  toast.success(`${offer.undone}. ${REFRESH_FAILED_TEXT}`, {
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: "Refresh",
      // Done: the toast closes and the lists show the restored state; failed again: the same offer comes back.
      run: () =>
        offer.after?.().catch(() => {
          if (!sessionEnding()) offerRefresh(offer)
        }),
    },
  })
}

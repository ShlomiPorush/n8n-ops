import * as React from "react"
import { useConfirm } from "@/components/confirm"

/** Why a dialog closes: the user cancels it, its save worked, or its flow is done (Done after a result). */
export type CloseReason = "cancel" | "saved" | "finished"

/*
 * A dialog with typed input asks before it drops what was typed (DS-9). Its owner holds the close: X, Escape,
 * Back and the phone pull-down reach `onOpenChange(false)`, Cancel and the owner's own closes call
 * `requestClose`. While the form differs from how it opened, a cancel asks "Discard your changes?" with the
 * focus on Keep editing (DS-12); a save or a finished flow closes at once and also closes a question still open
 * for it. The owner's `close` does the rest of its cleanup, such as clearing its fields. A link out of the
 * dialog asks with `confirmDiscard`, which does not close, so it can navigate before the dialog closes (DS-10).
 */
export function useDiscardGuard(dirty: boolean, close: () => void) {
  const confirm = useConfirm()
  const latest = React.useRef({ dirty, close })
  latest.current = { dirty, close }
  const asking = React.useRef<AbortController | null>(null)

  /** Asks, without closing, whether what was typed may be dropped; true at once when nothing was typed. */
  const confirmDiscard = React.useCallback(async (): Promise<boolean> => {
    if (!latest.current.dirty) return true
    // A second close while the question is open can only be Back (the question covers the rest): like
    // Escape on the question, it keeps editing (DS-12).
    if (asking.current) {
      asking.current.abort()
      asking.current = null
      return false
    }
    const question = new AbortController()
    asking.current = question
    const discard = await confirm({
      title: "Discard Your Changes?",
      message: "Your changes in this window will be lost.",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      danger: true,
      focusCancel: true,
      noHistory: true,
      signal: question.signal,
    })
    if (asking.current === question) asking.current = null
    return discard
  }, [confirm])

  const requestClose = React.useCallback(
    (reason: CloseReason = "cancel"): Promise<boolean> => {
      // Without a question the close is done at once, in the same event, so Back sees the dialog closed.
      if (reason !== "cancel" || !latest.current.dirty) {
        // A save or a finished flow also closes a question still open for this dialog.
        asking.current?.abort()
        asking.current = null
        latest.current.close()
        return Promise.resolve(true)
      }
      return confirmDiscard().then((discard) => {
        if (discard) latest.current.close()
        return discard
      })
    },
    [confirmDiscard],
  )
  // Only a close goes through the guard; a dialog with a trigger still opens itself.
  const onOpenChange = React.useCallback(
    (open: boolean) => {
      if (!open) void requestClose("cancel")
    },
    [requestClose],
  )
  // A dialog that unmounts takes its question with it.
  React.useEffect(() => () => asking.current?.abort(), [])
  return { requestClose, onOpenChange, confirmDiscard }
}

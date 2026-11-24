import * as React from "react"
import { useConfirm } from "@/components/confirm"

export type CloseReason = "cancel" | "saved" | "finished"

export function useDiscardGuard(dirty: boolean, close: () => void) {
  const confirm = useConfirm()
  const latest = React.useRef({ dirty, close })
  latest.current = { dirty, close }
  const asking = React.useRef<AbortController | null>(null)

  const confirmDiscard = React.useCallback(async (): Promise<boolean> => {
    if (!latest.current.dirty) return true
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
      if (reason !== "cancel" || !latest.current.dirty) {
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
  const onOpenChange = React.useCallback(
    (open: boolean) => {
      if (!open) void requestClose("cancel")
    },
    [requestClose],
  )
  React.useEffect(() => () => asking.current?.abort(), [])
  return { requestClose, onOpenChange, confirmDiscard }
}

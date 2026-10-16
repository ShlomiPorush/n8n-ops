import * as React from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { CONFIRM_FOCUS_MS } from "@/lib/behavior"

/*
 * The one confirmation (DS-12, DS-20, FW-8). Ask only before an action that deletes, is permanent or affects
 * many items; a single reversible action runs on one click. The question names the object, the count and the
 * consequence, and the button is named after the action. A dangerous action gets the one solid red button of
 * the app. The confirm button takes the focus, so Enter confirms; Escape, Cancel, the backdrop and Back cancel.
 */

export type ConfirmOptions = {
  title: string
  message?: React.ReactNode
  /** A verb: "Remove instance", "Revoke token". Never "OK". */
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
}

type Ask = (options: ConfirmOptions) => Promise<boolean>
const ConfirmContext = React.createContext<Ask | null>(null)

export function useConfirm(): Ask {
  const ask = React.useContext(ConfirmContext)
  if (!ask) throw new Error("useConfirm needs a ConfirmProvider")
  return ask
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null)
  const confirmRef = React.useRef<HTMLButtonElement>(null)

  const ask = React.useCallback<Ask>(
    (options) =>
      new Promise<boolean>((resolve) => {
        // A second question replaces the first, which counts as cancelled.
        setPending((previous) => {
          previous?.resolve(false)
          return { ...options, resolve }
        })
      }),
    [],
  )
  const finish = (ok: boolean) => {
    pending?.resolve(ok)
    setPending(null)
  }

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      <Dialog open={pending !== null} onOpenChange={(open) => !open && finish(false)}>
        {pending && (
          <DialogContent
            role="alertdialog"
            aria-label={pending.title}
            showCloseButton={false}
            className="md:max-w-[460px]"
            onOpenAutoFocus={(e) => {
              e.preventDefault()
              setTimeout(() => confirmRef.current?.focus(), CONFIRM_FOCUS_MS)
            }}
          >
            <DialogHeader className="pe-pad-x">
              <DialogTitle>{pending.title}</DialogTitle>
            </DialogHeader>
            {pending.message ? (
              <DialogDescription className="text-body whitespace-pre-line text-ink">
                {pending.message}
              </DialogDescription>
            ) : (
              <DialogDescription className="sr-only">{pending.title}</DialogDescription>
            )}
            <DialogFooter>
              <Button id="confirm-cancel" onClick={() => finish(false)}>
                {pending.cancelLabel ?? "Cancel"}
              </Button>
              <Button
                ref={confirmRef}
                variant={pending.danger ? "danger-solid" : "primary"}
                onClick={() => finish(true)}
              >
                {pending.confirmLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  )
}

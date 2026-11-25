import { TriangleAlert } from "lucide-react"
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

export type ConfirmOptions = {
  title: string
  message?: React.ReactNode
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  focusCancel?: boolean
  noHistory?: boolean
  signal?: AbortSignal
}

type Ask = (options: ConfirmOptions) => Promise<boolean>
const ConfirmContext = React.createContext<Ask | null>(null)

export function useConfirm(): Ask {
  const ask = React.useContext(ConfirmContext)
  if (!ask) throw new Error("useConfirm needs a ConfirmProvider")
  return ask
}

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void }

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<Pending | null>(null)
  const confirmRef = React.useRef<HTMLButtonElement>(null)
  const cancelRef = React.useRef<HTMLButtonElement>(null)

  const ask = React.useCallback<Ask>(
    (options) =>
      new Promise<boolean>((resolve) => {
        if (options.signal?.aborted) return resolve(false)
        const question: Pending = { ...options, resolve }
        setPending((previous) => {
          previous?.resolve(false)
          return question
        })
        options.signal?.addEventListener(
          "abort",
          () => {
            resolve(false)
            setPending((current) => (current === question ? null : current))
          },
          { once: true },
        )
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
            history={!pending.noHistory}
            className="md:max-w-[460px]"
            onOpenAutoFocus={(e) => {
              e.preventDefault()
              const target = pending.focusCancel ? cancelRef : confirmRef
              setTimeout(() => target.current?.focus(), CONFIRM_FOCUS_MS)
            }}
          >
            <DialogHeader
              className="pe-pad-x"
              icon={pending.danger ? TriangleAlert : undefined}
              tone={pending.danger ? "fail" : undefined}
            >
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
              <Button id="confirm-cancel" ref={cancelRef} onClick={() => finish(false)}>
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

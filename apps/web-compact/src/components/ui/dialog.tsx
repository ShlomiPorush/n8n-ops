import { type LucideIcon, XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"
import * as React from "react"
import { Button } from "@/components/ui/button"
import { PHONE_QUERY, SHEET_PULL_CLOSE_PX, SHEET_SLIDE_MS } from "@/lib/behavior"
import { useOverlayHistory } from "@/lib/overlay-history"
import { cn } from "@/lib/utils"

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/45 duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        className,
      )}
      {...props}
    />
  )
}

/**
 * Phone sheet gestures (DS-1, DS-3, DS-4). Scrolling first raises the sheet by exactly the scrolled distance
 * until it fills the screen, then the content scrolls. Dragging the grip or the head up grows the sheet with
 * the finger; pulling down moves it, and released past min(120px, a quarter of its height) it slides away,
 * otherwise it springs back. A pull from the content moves the sheet only when the content is at its top.
 * Touch only: with a mouse the sheet does not drag.
 */
function useSheetGestures(
  panel: HTMLDivElement | null,
  closeRef: React.RefObject<HTMLButtonElement | null>,
  canPullClose: boolean,
) {
  React.useEffect(() => {
    if (!panel) return
    const phone = () => window.matchMedia(PHONE_QUERY).matches
    const markFull = () => panel.toggleAttribute("data-full", panel.offsetHeight >= window.innerHeight - 1)
    const grow = (to: number) => {
      panel.style.maxHeight = "none"
      panel.style.height = `${Math.min(window.innerHeight, to)}px`
      markFull()
    }

    // One passive capture-phase listener catches every inner scroller.
    const onScroll = (e: Event) => {
      if (!phone()) return
      const scroller = e.target as HTMLElement
      const room = window.innerHeight - panel.offsetHeight
      const by = Math.min(scroller.scrollTop, room)
      if (by < 1) return
      grow(panel.offsetHeight + by)
      scroller.scrollTop -= by
    }

    let drag: { y: number; height: number; head: boolean; dy: number } | null = null
    const onStart = (e: TouchEvent) => {
      if (!phone() || e.touches.length !== 1) return
      const target = e.target as HTMLElement
      const head = Boolean(target.closest('[data-slot="dialog-grip"], [data-slot="dialog-header"]'))
      if (!head) {
        // Any scroller between the finger and the sheet that is not at its top keeps the gesture.
        for (let el: HTMLElement | null = target; el && el !== panel; el = el.parentElement) {
          if (el.scrollTop > 0) return
        }
      }
      drag = { y: e.touches[0]?.clientY ?? 0, height: panel.offsetHeight, head, dy: 0 }
      if (head) panel.setAttribute("data-held", "")
      panel.style.transition = "none"
    }
    const onMove = (e: TouchEvent) => {
      if (!drag) return
      const dy = (e.touches[0]?.clientY ?? drag.y) - drag.y
      drag.dy = dy
      if (dy < 0) {
        // An upward drag from the content scrolls the content; only the head grows the sheet.
        if (!drag.head) return
        panel.style.transform = ""
        grow(drag.height - dy)
      } else {
        panel.style.transform = `translateY(${dy}px)`
      }
    }
    const onEnd = () => {
      if (!drag) return
      const { dy } = drag
      drag = null
      panel.removeAttribute("data-held")
      panel.style.transition = `transform ${SHEET_SLIDE_MS}ms ease`
      if (dy > 0 && canPullClose && dy > Math.min(SHEET_PULL_CLOSE_PX, panel.offsetHeight / 4)) {
        panel.style.transform = "translateY(100%)"
        // Close through the dialog's own Close, so its owner's cleanup and its Back entry run.
        setTimeout(() => closeRef.current?.click(), SHEET_SLIDE_MS)
      } else {
        panel.style.transform = ""
      }
    }

    panel.addEventListener("scroll", onScroll, { capture: true, passive: true })
    panel.addEventListener("touchstart", onStart, { passive: true })
    panel.addEventListener("touchmove", onMove, { passive: true })
    panel.addEventListener("touchend", onEnd, { passive: true })
    panel.addEventListener("touchcancel", onEnd, { passive: true })
    return () => {
      panel.removeEventListener("scroll", onScroll, { capture: true })
      panel.removeEventListener("touchstart", onStart)
      panel.removeEventListener("touchmove", onMove)
      panel.removeEventListener("touchend", onEnd)
      panel.removeEventListener("touchcancel", onEnd)
    }
  }, [panel, closeRef, canPullClose])
}

/**
 * A dialog: centered, up to 90% high, the header and the footer stay while the body scrolls. Pass a max-w
 * class for the width (up to 1100px).
 *
 * On a phone every dialog is a bottom sheet with a grip that opens at four fifths of the screen, grows with
 * the scroll and squares its corners at full height; pulled down it closes (DS-1 to DS-4).
 *
 * Escape and Back close only the top layer (DS-8, DS-10). An information window closes on a backdrop click;
 * a dialog with typed input sets `keepOnBackdrop` and closes only by Cancel or X (DS-9). A dialog whose state
 * is in the address already gets Back from the router and sets `history={false}`.
 */
function DialogContent({
  className,
  children,
  showCloseButton = true,
  keepOnBackdrop = false,
  pullToClose,
  history = true,
  onPointerDownOutside,
  onInteractOutside,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  keepOnBackdrop?: boolean
  /** Whether pulling the phone sheet down closes it; by default when it has a Close button. */
  pullToClose?: boolean
  history?: boolean
}) {
  // The panel mounts after this component (the portal waits a render), so it is tracked as state.
  const [panel, setPanel] = React.useState<HTMLDivElement | null>(null)
  const closeRef = React.useRef<HTMLButtonElement>(null)
  useSheetGestures(panel, closeRef, pullToClose ?? showCloseButton)
  // This component renders also while its dialog is closed; only a mounted panel holds a Back entry.
  useOverlayHistory(history && panel !== null, () => closeRef.current?.click())

  // A click on the toast is not a click on the backdrop.
  const outside = (e: { target: EventTarget | null; preventDefault(): void }) => {
    if (keepOnBackdrop || (e.target instanceof Element && e.target.closest("[data-toast]"))) e.preventDefault()
  }

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={setPanel}
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[90dvh] w-full max-w-md -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg bg-popover text-body text-popover-foreground shadow-modal duration-150 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          // Phone: a bottom sheet; the size, corners and notch rules are in index.css.
          "max-md:max-w-none! max-md:translate-x-0 max-md:translate-y-0 max-md:duration-200 max-md:data-[state=closed]:slide-out-to-bottom max-md:data-[state=open]:slide-in-from-bottom",
          className,
        )}
        onPointerDownOutside={(e) => {
          outside(e)
          onPointerDownOutside?.(e)
        }}
        onInteractOutside={(e) => {
          outside(e)
          onInteractOutside?.(e)
        }}
        {...props}
      >
        <div data-slot="dialog-grip" aria-hidden className="hidden max-md:grid">
          <span />
        </div>
        <div
          data-slot="dialog-body"
          // A footer ends the body itself: padding under it would show below the buttons in a scroll container.
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-pad-x pb-pad-x has-[>[data-slot=dialog-footer]:last-child]:pb-0 max-md:pb-[calc(var(--spacing-pad-x)+env(safe-area-inset-bottom))] max-md:has-[>[data-slot=dialog-footer]:last-child]:pb-0"
        >
          {children}
        </div>
        {showCloseButton ? (
          <DialogPrimitive.Close data-slot="dialog-close" asChild ref={closeRef}>
            <Button size="icon-sm" className="absolute end-2.5 top-2.5 z-20 max-md:top-[26px]" aria-label="Close">
              <XIcon />
            </Button>
          </DialogPrimitive.Close>
        ) : (
          <DialogPrimitive.Close ref={closeRef} tabIndex={-1} aria-hidden className="hidden" />
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({
  className,
  icon: Icon,
  tone,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  /** What the dialog is about; Regular draws it above the title, red for an action that removes something. */
  icon?: LucideIcon
  tone?: "fail"
}) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "sticky top-0 z-10 -mx-pad-x flex shrink-0 flex-col gap-1 border-b bg-popover px-pad-x pt-3.5 pb-2.5 pe-12",
        className,
      )}
      {...props}
    >
      {Icon && (
        <span
          aria-hidden
          className={cn(
            "mb-1 hidden size-10 place-items-center rounded-lg bg-fill ring-1 ring-line ring-inset regular:grid",
            tone === "fail" && "tint-fail ring-fail/20",
          )}
        >
          <Icon className="size-5" />
        </span>
      )}
      {children}
    </div>
  )
}

function DialogFooter({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "sticky bottom-0 z-10 -mx-pad-x mt-auto flex shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-popover px-pad-x py-3 max-md:pb-[calc(12px+env(safe-area-inset-bottom))]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("text-h2", className)} {...props} />
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-small text-muted-foreground [&_a]:font-semibold [&_a]:underline", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}

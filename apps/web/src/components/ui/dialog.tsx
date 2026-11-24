import { type LucideIcon, XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"
import * as React from "react"
import { Button } from "@/components/ui/button"
import { PHONE_QUERY, SHEET_PULL_CLOSE_PX, SHEET_SLIDE_MS, touchOnly } from "@/lib/behavior"
import { inertBeside } from "@/lib/inert"
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

const overlayClass =
  "fixed inset-0 isolate z-50 bg-black/45 duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return <DialogPrimitive.Overlay data-slot="dialog-overlay" className={cn(overlayClass, className)} {...props} />
}

function tabToToast(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return
  const toast = [...document.querySelectorAll<HTMLElement>("[data-toast] button")]
  if (toast.length === 0) return
  const tabbable = [
    ...e.currentTarget.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]"),
  ].filter((el) => el.tabIndex >= 0 && !el.matches(":disabled") && el.getClientRects().length > 0)
  const edge = e.shiftKey ? tabbable[0] : tabbable.at(-1)
  if (edge && document.activeElement !== edge) return
  e.preventDefault()
  ;(e.shiftKey ? toast.at(-1) : toast[0])?.focus()
}

export function attachSheetGestures(panel: HTMLElement, close: () => void, canPullClose: boolean): () => void {
  const phone = () => window.matchMedia(PHONE_QUERY).matches
  const markFull = () => panel.toggleAttribute("data-full", panel.offsetHeight >= window.innerHeight - 1)
  const grow = (to: number) => {
    panel.style.maxHeight = "none"
    panel.style.height = `${Math.min(window.innerHeight, to)}px`
    markFull()
  }

  const onScroll = (e: Event) => {
    if (!phone()) return
    const scroller = e.target as HTMLElement
    const room = window.innerHeight - panel.offsetHeight
    const by = Math.min(scroller.scrollTop, room)
    if (by < 1) return
    grow(panel.offsetHeight + by)
    scroller.scrollTop -= by
  }

  let drag: { y: number; height: number; head: boolean; dy: number; grown: boolean } | null = null
  let blocked = false
  const cancel = () => {
    if (drag) {
      const { height, grown } = drag
      drag = null
      panel.removeAttribute("data-held")
      panel.style.transition = `transform ${SHEET_SLIDE_MS}ms ease`
      panel.style.transform = ""
      if (grown) grow(height)
    }
    blocked = true
  }
  const onStart = (e: TouchEvent) => {
    if (blocked || !phone()) return
    if (e.touches.length !== 1) {
      cancel()
      return
    }
    const target = e.target as HTMLElement
    const head = Boolean(target.closest('[data-slot="dialog-grip"], [data-slot="dialog-header"]'))
    if (!head) {
      for (let el: HTMLElement | null = target; el && el !== panel; el = el.parentElement) {
        if (el.scrollTop > 0) return
      }
    }
    drag = { y: e.touches[0]?.clientY ?? 0, height: panel.offsetHeight, head, dy: 0, grown: false }
    if (head) panel.setAttribute("data-held", "")
    panel.style.transition = "none"
  }
  const onMove = (e: TouchEvent) => {
    if (!drag) return
    if (e.touches.length > 1) {
      cancel()
      return
    }
    const dy = (e.touches[0]?.clientY ?? drag.y) - drag.y
    drag.dy = dy
    if (dy < 0) {
      if (!drag.head) return
      panel.style.transform = ""
      drag.grown = true
      grow(drag.height - dy)
    } else {
      panel.style.transform = `translateY(${dy}px)`
    }
  }
  const onEnd = (e: TouchEvent) => {
    if (blocked) {
      if (e.touches.length === 0) blocked = false
      return
    }
    if (!drag) return
    const { dy } = drag
    drag = null
    panel.removeAttribute("data-held")
    panel.style.transition = `transform ${SHEET_SLIDE_MS}ms ease`
    if (dy > 0 && canPullClose && dy > Math.min(SHEET_PULL_CLOSE_PX, panel.offsetHeight / 4)) {
      panel.style.transform = "translateY(100%)"
      setTimeout(() => {
        close()
        setTimeout(() => {
          if (panel.isConnected && panel.dataset.state === "open") panel.style.transform = ""
        }, SHEET_SLIDE_MS)
      }, SHEET_SLIDE_MS)
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
}

function useSheetGestures(
  panel: HTMLDivElement | null,
  closeRef: React.RefObject<HTMLButtonElement | null>,
  canPullClose: boolean,
) {
  React.useEffect(() => {
    if (!panel) return
    return attachSheetGestures(panel, () => closeRef.current?.click(), canPullClose)
  }, [panel, closeRef, canPullClose])
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  keepOnBackdrop = false,
  pullToClose,
  history = true,
  scrollPane,
  inertPage,
  onPointerDownOutside,
  onInteractOutside,
  onOpenAutoFocus,
  onKeyDown,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  keepOnBackdrop?: boolean
  pullToClose?: boolean
  history?: boolean
  scrollPane?: string
  inertPage?: boolean
}) {
  const [panel, setPanel] = React.useState<HTMLDivElement | null>(null)
  React.useEffect(() => {
    if (!inertPage || !panel) return
    return inertBeside(panel)
  }, [inertPage, panel])
  const closeRef = React.useRef<HTMLButtonElement>(null)
  useSheetGestures(panel, closeRef, pullToClose ?? showCloseButton)
  useOverlayHistory(
    history && panel !== null,
    () => closeRef.current?.click(),
    () => panel?.isConnected === true && panel.dataset.state === "open",
  )

  const outside = (e: { target: EventTarget | null; preventDefault(): void }) => {
    if (keepOnBackdrop || (e.target instanceof Element && e.target.closest("[data-toast]"))) e.preventDefault()
  }

  return (
    <DialogPortal>
      {inertPage !== undefined ? (
        <div
          aria-hidden
          data-slot="dialog-overlay"
          data-state={inertPage ? "open" : "closed"}
          className={overlayClass}
        />
      ) : (
        <DialogOverlay />
      )}
      <DialogPrimitive.Content
        ref={setPanel}
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[90dvh] w-full max-w-md -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg bg-popover text-body text-popover-foreground shadow-modal duration-150 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          "md:w-[calc(100%-32px)]",
          "max-md:max-w-none! max-md:translate-x-0 max-md:translate-y-0 max-md:duration-200 max-md:data-[state=closed]:slide-out-to-bottom max-md:data-[state=open]:slide-in-from-bottom",
          "compact:max-md:shadow-sheet",
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
        onOpenAutoFocus={
          onOpenAutoFocus ??
          ((e) => {
            if (!touchOnly()) return
            e.preventDefault()
            ;(e.currentTarget as HTMLElement).focus({ preventScroll: true })
          })
        }
        onKeyDown={(e) => {
          onKeyDown?.(e)
          if (inertPage && !e.defaultPrevented) tabToToast(e)
        }}
        {...props}
      >
        <div data-slot="dialog-grip" aria-hidden className="hidden max-md:grid">
          <span />
        </div>
        <div
          data-slot="dialog-body"
          data-scroll-pane={scrollPane}
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-pad-x pb-pad-x has-[>[data-slot=dialog-footer]:last-child]:pb-0 has-[>[data-slot=pane-footer]:last-child>:not(:empty)]:pb-0 max-md:pb-[calc(var(--spacing-pad-x)+env(safe-area-inset-bottom))] max-md:has-[>[data-slot=dialog-footer]:last-child]:pb-0 max-md:has-[>[data-slot=pane-footer]:last-child>:not(:empty)]:pb-0"
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
  icon?: LucideIcon
  tone?: "fail"
}) {
  const measure = React.useCallback((el: HTMLDivElement | null) => {
    const body = el?.parentElement
    if (!el || !body) return
    const set = () => body.style.setProperty("--dialog-head-h", `${el.offsetHeight}px`)
    set()
    const observer = new ResizeObserver(set)
    observer.observe(el)
    return () => {
      observer.disconnect()
      body.style.removeProperty("--dialog-head-h")
    }
  }, [])
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "sticky top-0 z-10 -mx-pad-x flex shrink-0 flex-col gap-1 border-b bg-popover px-pad-x pt-3.5 pb-2.5 pe-12",
        className,
      )}
      {...props}
      ref={measure}
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
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-h2 compact:font-bold compact:tracking-none", className)}
      {...props}
    />
  )
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

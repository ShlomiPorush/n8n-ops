import { CircleAlert, CircleCheck, Info, Loader2, LoaderCircle, TriangleAlert, X } from "lucide-react"
import { useLayoutEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { type ToastTone, toast, useCurrentToast } from "@/lib/toast"
import { cn } from "@/lib/utils"

const icons: Record<ToastTone, typeof Info> = {
  success: CircleCheck,
  error: CircleAlert,
  warning: TriangleAlert,
  info: Info,
  loading: Loader2,
}

/**
 * The one toast: bottom end corner (above the tab bar on a phone), a 4px status edge, an icon by type and at most
 * one action (FB-2). Its clock is in lib/toast.ts: it waits while the pointer or the keyboard is on it, or while
 * its action runs, and X closes it at once. When the keyboard was in the toast it replaces, the keyboard moves to
 * this one's action, else its X. Errors interrupt screen readers (role="alert"); everything else is polite.
 */
export function Toaster() {
  const item = useCurrentToast()
  const ref = useRef<HTMLDivElement>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new toast takes the keyboard over
  useLayoutEffect(() => {
    if (item?.takeFocus)
      ref.current?.querySelector<HTMLElement>("[data-toast-action], [data-toast-close]")?.focus({ preventScroll: true })
  }, [item?.key])

  if (!item) return null
  const Icon = icons[item.tone]
  const tone =
    item.tone === "success" ? "ok" : item.tone === "error" ? "fail" : item.tone === "warning" ? "warn" : "info"
  const key = item.key
  return (
    <div
      data-toast
      key={key}
      ref={ref}
      role={item.tone === "error" ? "alert" : "status"}
      onPointerEnter={() => toast.hold(key, "pointer")}
      onPointerLeave={() => toast.release(key, "pointer")}
      onFocus={() => toast.hold(key, "focus")}
      onBlur={(e) => {
        // Moving between the action and X keeps it held.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) toast.release(key, "focus")
      }}
      className={cn(
        "pointer-events-auto fixed end-[18px] bottom-[18px] z-[100000] flex w-[min(420px,calc(100vw-36px))] items-start gap-2.5 rounded-lg border-s-4 bg-popover py-2.5 ps-3 pe-1.5 text-body text-popover-foreground shadow-float transition-opacity duration-300 animate-in fade-in-0 slide-in-from-bottom-2",
        "max-md:inset-x-3 max-md:bottom-[calc(var(--spacing-tabbar)+12px+env(safe-area-inset-bottom))] max-md:w-auto",
        tone === "ok" && "border-s-ok",
        tone === "fail" && "border-s-fail",
        tone === "warn" && "border-s-warn",
        tone === "info" && "border-s-info",
        item.leaving && "opacity-0",
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "ok" && "text-ok",
          tone === "fail" && "text-fail",
          tone === "warn" && "text-warn",
          tone === "info" && "text-info",
          item.tone === "loading" && "animate-spin text-muted-foreground",
        )}
      />
      <p className="min-w-0 flex-1 py-px [overflow-wrap:anywhere]">{item.message}</p>
      {item.action && (
        // A running action keeps the keyboard: aria-disabled, not disabled, and its clicks are ignored (FB-2).
        <Button
          data-toast-action
          size="sm"
          aria-label={item.action.ariaLabel}
          aria-disabled={item.running || undefined}
          aria-busy={item.running || undefined}
          onClick={() => toast.act(key)}
          className="-my-1"
        >
          {item.running && <LoaderCircle aria-hidden className="animate-spin" />}
          {item.action.label}
        </Button>
      )}
      <button
        type="button"
        data-toast-close
        aria-label="Close"
        onClick={() => toast.dismiss(item.id)}
        className="-my-1 grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground [@media(hover:hover)]:hover:bg-accent [@media(hover:hover)]:hover:text-ink"
      >
        <X aria-hidden className="size-4" />
      </button>
    </div>
  )
}

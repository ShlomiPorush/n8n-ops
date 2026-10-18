import { CircleAlert, CircleCheck, Info, Loader2, TriangleAlert, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { TOAST_FADE_MS, TOAST_MS } from "@/lib/behavior"
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
 * The one toast: bottom end corner (above the tab bar on a phone), a 4px status edge and an icon by type.
 * It closes after four seconds and fades; it waits while the pointer is on it, and X closes it at once.
 * Errors interrupt screen readers (role="alert"); everything else is polite (role="status").
 */
export function Toaster() {
  const item = useCurrentToast()
  const [leaving, setLeaving] = useState(false)
  const [hovered, setHovered] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // biome-ignore lint/correctness/useExhaustiveDependencies: each new toast starts visible
  useEffect(() => setLeaving(false), [item?.key])

  useEffect(() => {
    clearTimeout(timer.current)
    if (!item || item.tone === "loading" || hovered) return
    timer.current = setTimeout(() => {
      setLeaving(true)
      timer.current = setTimeout(() => toast.dismiss(item.id), TOAST_FADE_MS)
    }, TOAST_MS)
    return () => clearTimeout(timer.current)
  }, [item, hovered])

  if (!item) return null
  const Icon = icons[item.tone]
  const tone =
    item.tone === "success" ? "ok" : item.tone === "error" ? "fail" : item.tone === "warning" ? "warn" : "info"
  return (
    <div
      data-toast
      key={item.key}
      role={item.tone === "error" ? "alert" : "status"}
      onPointerEnter={() => {
        setHovered(true)
        setLeaving(false)
      }}
      onPointerLeave={() => setHovered(false)}
      className={cn(
        "pointer-events-auto fixed end-[18px] bottom-[18px] z-[100000] flex w-[min(420px,calc(100vw-36px))] items-start gap-2.5 rounded-lg border-s-4 bg-popover py-2.5 ps-3 pe-1.5 text-body text-popover-foreground shadow-float transition-opacity duration-300 animate-in fade-in-0 slide-in-from-bottom-2",
        "max-md:inset-x-3 max-md:bottom-[calc(var(--spacing-tabbar)+12px+env(safe-area-inset-bottom))] max-md:w-auto",
        tone === "ok" && "border-s-ok",
        tone === "fail" && "border-s-fail",
        tone === "warn" && "border-s-warn",
        tone === "info" && "border-s-info",
        leaving && "opacity-0",
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
      <button
        type="button"
        aria-label="Close"
        onClick={() => toast.dismiss(item.id)}
        className="-my-1 grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground [@media(hover:hover)]:hover:bg-accent [@media(hover:hover)]:hover:text-ink"
      >
        <X aria-hidden className="size-4" />
      </button>
    </div>
  )
}

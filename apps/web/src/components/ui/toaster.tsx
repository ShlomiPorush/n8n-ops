import { CircleAlert, CircleCheck, Info, Loader2, LoaderCircle, TriangleAlert, X } from "lucide-react"
import { useLayoutEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { currentToast, type ToastItem, type ToastTone, toast, useCurrentToast } from "@/lib/toast"
import { cn } from "@/lib/utils"

const icons: Record<ToastTone, typeof Info> = {
  success: CircleCheck,
  error: CircleAlert,
  warning: TriangleAlert,
  info: Info,
  loading: Loader2,
}

export function Toaster() {
  const item = useCurrentToast()
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (item?.takeFocus)
      ref.current?.querySelector<HTMLElement>("[data-toast-action], [data-toast-close]")?.focus({ preventScroll: true })
  }, [item?.key])

  const pointer = (over: boolean) => {
    const shown = currentToast()?.key
    if (shown === undefined) return
    if (over) toast.hold(shown, "pointer")
    else toast.release(shown, "pointer")
  }
  return (
    <div
      data-slot="toaster"
      onPointerEnter={() => pointer(true)}
      onPointerLeave={() => pointer(false)}
      className={cn(
        "pointer-events-auto fixed end-[18px] bottom-[18px] z-[100000] w-[min(420px,calc(100vw-36px))]",
        "max-md:inset-x-3 max-md:bottom-[calc(var(--spacing-tabbar)+12px+env(safe-area-inset-bottom))] max-md:w-auto",
      )}
    >
      {item && <ToastBody item={item} panel={ref} />}
    </div>
  )
}

function ToastBody({ item, panel }: { item: ToastItem; panel: React.Ref<HTMLDivElement> }) {
  const Icon = icons[item.tone]
  const tone =
    item.tone === "success" ? "ok" : item.tone === "error" ? "fail" : item.tone === "warning" ? "warn" : "info"
  const key = item.key
  return (
    <div
      data-toast
      key={key}
      ref={panel}
      role={item.tone === "error" ? "alert" : "status"}
      onFocus={() => toast.hold(key, "focus")}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) toast.release(key, "focus")
      }}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border-s-4 bg-popover py-2.5 ps-3 pe-1.5 text-body text-popover-foreground shadow-float transition-opacity duration-300 animate-in fade-in-0 slide-in-from-bottom-2",
        "compact:rounded-sm compact:border-y compact:border-e compact:text-small",
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

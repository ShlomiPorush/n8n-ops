import { Check, Copy, Loader2, Lock } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { describeError } from "@/lib/api"
import { cn } from "@/lib/utils"

/*
 * The small set of page building blocks. Pages are made of these and the primitives in components/ui;
 * a new block is added only when none of these fits.
 */

/** A page: header, then a column of blocks with the standard gap. */
export function Page({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string
  description?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("grid min-w-0 content-start gap-gap", className)}>
      {title && <PageHead title={title} description={description} actions={actions} />}
      {children}
    </div>
  )
}

/** The page title, a one line description under it, and the page actions at the bottom of the far side. */
export function PageHead({
  title,
  description,
  actions,
}: {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="mb-1 flex flex-wrap items-end gap-x-4 gap-y-3">
      <div className="min-w-0 flex-1 basis-80">
        <h1 className="text-h1">{title}</h1>
        {description && <p className="mt-1.5 text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** The base unit: a tinted panel. Rows inside it are split by a 1px top line only. */
export function Panel({ className, ...props }: React.ComponentProps<"section">) {
  return <section className={cn("min-w-0 overflow-hidden rounded-lg bg-panel", className)} {...props} />
}

/** A panel header: a short noun, a muted count beside it, and a "more" link or an action on the far side. */
export function PanelHead({
  title,
  count,
  more,
  action,
  description,
  className,
}: {
  title: React.ReactNode
  count?: React.ReactNode
  more?: { to: string; label: string }
  action?: React.ReactNode
  description?: React.ReactNode
  className?: string
}) {
  return (
    <header className={cn("px-pad-x pt-[13px] pb-[9px]", className)}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <h2 className="text-head">{title}</h2>
        {count !== undefined && <span className="font-medium text-muted-foreground tabular-nums">{count}</span>}
        {(more || action) && (
          <div className="ms-auto flex items-center gap-2">
            {action}
            {more && (
              <Link to={more.to} className="text-ctl font-semibold underline">
                {more.label}
              </Link>
            )}
          </div>
        )}
      </div>
      {description && <p className="mt-0.5 text-small text-muted-foreground">{description}</p>}
    </header>
  )
}

/** A row in a panel. Pass onClick or asChild-like Link via `to` for a clickable row. */
export function Row({
  className,
  to,
  onClick,
  current,
  edge,
  children,
}: {
  className?: string
  to?: string
  onClick?: () => void
  current?: boolean
  /** A 3px status edge at the start; healthy rows keep it quiet. */
  edge?: "ok" | "warn" | "fail" | "info" | "muted"
  children: React.ReactNode
}) {
  const cls = cn(
    "flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-line px-pad-x py-pad-y",
    (to || onClick) && "hover-row",
    current && "bg-accent",
    edge && "border-s-3",
    edge === "ok" && "border-s-ok/55",
    edge === "warn" && "border-s-warn",
    edge === "fail" && "border-s-fail",
    edge === "info" && "border-s-info",
    edge === "muted" && "border-s-muted-foreground/40",
    className,
  )
  if (to)
    return (
      <Link to={to} className={cls} aria-current={current ? "page" : undefined}>
        {children}
      </Link>
    )
  if (onClick)
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(cls, "w-full text-start")}
        aria-current={current || undefined}
      >
        {children}
      </button>
    )
  return <div className={cls}>{children}</div>
}

/** A key value row: the muted label at the start, the value in 650 weight at the end. */
export function KV({
  label,
  children,
  className,
}: {
  label: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5 border-t border-line px-pad-x py-[7px]", className)}>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="ms-auto min-w-0 text-end font-title break-words tabular-nums">{children}</span>
    </div>
  )
}

/** An alert row: a 4px status bar, the text, one action. */
export function AlertRow({
  tone,
  title,
  children,
  action,
  to,
}: {
  tone: "fail" | "warn" | "info"
  title: React.ReactNode
  children?: React.ReactNode
  action?: React.ReactNode
  to?: string
}) {
  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          "w-1 shrink-0 self-stretch rounded-e-[4px]",
          tone === "fail" && "bg-fail",
          tone === "warn" && "bg-warn",
          tone === "info" && "bg-info",
        )}
      />
      <div className="min-w-0 flex-1 py-pad-y">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">{title}</div>
        {children && <div className="mt-0.5 text-small break-words text-muted-foreground">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center pe-pad-x">{action}</div>}
    </>
  )
  const cls = "flex items-start gap-3.5 border-t border-line pe-pad-x"
  if (to)
    return (
      <Link to={to} className={cn(cls, "hover-row")}>
        {body}
      </Link>
    )
  return <div className={cls}>{body}</div>
}

/** Key figures: a large number over a muted label. Cell lines are outlines, so a short last row leaves no block. */
export function Kpis({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] overflow-hidden rounded-lg border border-line bg-bg",
        className,
      )}
    >
      {children}
    </div>
  )
}

export function Kpi({
  label,
  value,
  hint,
  tone,
  to,
}: {
  label: React.ReactNode
  value: React.ReactNode
  hint?: React.ReactNode
  tone?: "fail" | "warn" | "ok"
  /** Every count is a link to the list it counts. */
  to?: string
}) {
  const inner = (
    <>
      <b
        className={cn(
          "block text-figure tabular-nums",
          tone === "fail" && "text-fail",
          tone === "warn" && "text-warn",
          tone === "ok" && "text-ok",
        )}
      >
        {value}
      </b>
      <span className="block text-small text-muted-foreground">{label}</span>
      {hint && <span className="mt-0.5 block text-meta text-muted-foreground">{hint}</span>}
    </>
  )
  const cls = "block min-w-0 px-pad-x py-[11px] outline outline-line"
  return to ? (
    <Link to={to} className={cn(cls, "hover-row")}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  )
}

/** Loading: a 24px spinner with a short sentence. */
export function Loading({ children = "Loading…", className }: { children?: React.ReactNode; className?: string }) {
  return (
    <div
      role="status"
      className={cn("grid justify-items-center gap-2 px-pad-x py-[22px] text-small text-muted-foreground", className)}
    >
      <Loader2 className="size-6 animate-spin" aria-hidden />
      <p>{children}</p>
    </div>
  )
}

/** Empty: one bold factual sentence about what is missing, a muted line under it, and at most one action. */
export function Empty({
  title,
  children,
  action,
  className,
}: {
  title: React.ReactNode
  children?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("px-pad-x py-9 text-center text-muted-foreground", className)}>
      <b className="mb-1 block font-title text-ink">{title}</b>
      {children && <p className="mx-auto max-w-prose">{children}</p>}
      {action && <div className="mt-3.5 flex justify-center">{action}</div>}
    </div>
  )
}

/** An area that could not load: what failed and the server's reason, with a retry. */
export function LoadError({ error, retry, what }: { error: unknown; retry?: () => void; what: string }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 px-pad-x py-[22px]">
      <div className="min-w-0 flex-1">
        <b className="block font-title text-fail">Could not load {what}</b>
        <p className="text-small text-muted-foreground">{describeError(error)}</p>
      </div>
      {retry && (
        <Button size="sm" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  )
}

/**
 * Locked: shown instead of a control that needs something missing. It says what is missing, why it
 * matters, and links to where it is set ("Settings → Backup storage").
 */
export function Locked({
  title,
  children,
  to,
  action,
  className,
}: {
  title: React.ReactNode
  children: React.ReactNode
  to: string
  action: string
  className?: string
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[20px_minmax(0,1fr)] items-center gap-x-3.5 gap-y-1 rounded-lg border border-dashed border-muted-foreground/55 bg-muted-foreground/7 px-pad-x py-3.5 md:grid-cols-[20px_minmax(0,1fr)_auto]",
        className,
      )}
    >
      <Lock className="size-5 text-muted-foreground" aria-hidden />
      <div className="min-w-0">
        <b className="block font-title">{title}</b>
        <p className="mt-0.5 text-muted-foreground">{children}</p>
      </div>
      <Button size="sm" asChild className="col-start-2 mt-2 justify-self-start md:col-start-3 md:mt-0">
        <Link to={to}>{action}</Link>
      </Button>
    </div>
  )
}

/**
 * An ID, address or key in mono that copies on click: a faint background and a copy icon on hover, the
 * full value copied (not the truncated one), a check for 1.5s and a toast that says what was copied.
 */
export function Copyable({
  value,
  children,
  className,
  label,
}: {
  value: string
  children?: React.ReactNode
  className?: string
  /** What the value is, for the accessible name ("Copy execution ID"). */
  label?: string
}) {
  const [done, setDone] = useState(false)
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    try {
      await navigator.clipboard.writeText(value)
      setDone(true)
      setTimeout(() => setDone(false), 1500)
      toast.success(`Copied: ${value.length > 80 ? `${value.slice(0, 80)}…` : value}`)
    } catch {
      toast.error("Could not copy. Select the text and copy it instead.")
    }
  }
  const Icon = done ? Check : Copy
  return (
    <button
      type="button"
      onClick={copy}
      title={value}
      aria-label={`${label ?? "Copy"}: ${value}`}
      className={cn(
        "group/copy inline-flex max-w-full min-w-0 items-center gap-1 rounded-tag px-1 -mx-1 text-start font-mono text-[0.9em] transition-colors duration-150 hover:bg-ink/6",
        className,
      )}
    >
      <span className="min-w-0 truncate" dir="auto">
        {children ?? value}
      </span>
      <Icon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/copy:opacity-100 group-focus-visible/copy:opacity-100",
          done && "text-ok opacity-100",
        )}
      />
    </button>
  )
}

/**
 * The save bar of an editable area: it floats at the bottom of the scrolling area and shows only while
 * there are unsaved changes.
 */
export function SaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
  label = "Save",
  disabled,
  note = "Unsaved changes",
}: {
  dirty: boolean
  saving?: boolean
  onSave: () => void
  onDiscard?: () => void
  label?: string
  disabled?: boolean
  note?: React.ReactNode
}) {
  if (!dirty) return null
  return (
    <section
      aria-label="Unsaved changes"
      className="sticky bottom-3 z-20 mx-auto flex w-full max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-popover py-2.5 ps-pad-x pe-2.5 shadow-float"
    >
      <span className="min-w-0 flex-1 font-semibold">{note}</span>
      {onDiscard && (
        <Button variant="ghost" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
      )}
      <Button variant="primary" onClick={onSave} disabled={saving || disabled}>
        {saving ? "Saving…" : label}
      </Button>
    </section>
  )
}

/** User-entered text (workflow, instance and token names) keeps its own direction. */
export function UserText({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span dir="auto" className={className}>
      <bdi>{children}</bdi>
    </span>
  )
}

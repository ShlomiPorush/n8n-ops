import { Check, Copy, Inbox, Loader2, LoaderCircle, Lock, type LucideIcon, X } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useLocation } from "react-router"
import { PageActions, useTopBar } from "@/app/chrome"
import { pageOf } from "@/app/nav"
import { Figure } from "@/components/skin/figure"
import { PageIcon, PageTitle } from "@/components/skin/page-title"
import { timeAgo, useTick } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { describeError } from "@/lib/api"
import { COPIED_MS, DIM_AFTER_MS } from "@/lib/behavior"
import { type BusyState, busyRun } from "@/lib/busy-run"
import { filterFailed, type Live, refreshFailed } from "@/lib/load-state"
import { rowHeld } from "@/lib/row-held"
import { formatTime, useTimeFormat } from "@/lib/time"
import { toast } from "@/lib/toast"
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
  live,
  updated,
  children,
  className,
}: {
  title?: string
  description?: React.ReactNode
  actions?: React.ReactNode
  live?: Live | Live[]
  updated?: boolean
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("grid min-w-0 content-start gap-gap", className)}>
      {title && <PageHead title={title} description={description} actions={actions} live={live} updated={updated} />}
      {children}
    </div>
  )
}

/**
 * The page head. From 761px the title is in the top bar and the actions move up beside it (NL-6), so the page
 * starts with its one line description. On a phone the title leads the page with the main action on its line
 * (NL-14). With `live` (the page's queries) a line says how fresh the data is and keeps ticking, and says so
 * when a refresh failed while the rows stay (LD-12, TB-5); `updated={false}` keeps only the failure.
 */
export function PageHead({
  title,
  description,
  actions,
  live,
  updated = true,
}: {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
  live?: Live | Live[]
  updated?: boolean
}) {
  const wide = useTopBar()
  const fresh = live ? <RefreshNote live={live} updated={updated} separator={description ? " · " : ""} /> : null
  const said = Boolean(description || fresh)
  if (wide)
    return (
      <>
        {actions && <PageActions>{actions}</PageActions>}
        {/* Regular also draws the page's icon and name here, large, above the line (#29). */}
        <div
          data-slot="page-head"
          className={cn("mb-1 regular:flex regular:items-start regular:gap-3.5", !said && "compact:hidden")}
        >
          <PageIcon />
          <div className="min-w-0">
            <PageTitle title={title} />
            {said && (
              <p className="text-muted-foreground regular:mt-0.5">
                {description}
                {fresh}
              </p>
            )}
          </div>
        </div>
      </>
    )
  return (
    <div className="mb-1 grid gap-1.5">
      <div className="flex items-start gap-3">
        <h1 className="min-w-0 flex-1 text-figure font-heavy tracking-tighter break-words regular:text-h1">{title}</h1>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {said && (
        <p className="text-muted-foreground">
          {description}
          {fresh}
        </p>
      )}
    </div>
  )
}

/** "Updated 3 min ago", with the exact time on hover; it keeps ticking while the page is open. */
function Updated({ at }: { at: number }) {
  useTick()
  const w = useTimeFormat()
  return <span title={formatTime(at, w)}>Updated {timeAgo(new Date(at))}</span>
}

/**
 * How fresh the data on screen is, inside a line of text (LD-12). While it is fresh: "Updated 3 min ago" (only with
 * `updated`). After a refresh that failed, with the data kept on screen (TB-5): "Could not refresh · Updated 4 min
 * ago" in amber with Try again, until the next good answer. "Could not refresh" sits in a polite live region that
 * stays mounted, so the failure is announced and the ticking time is not. `separator` leads it when it shows.
 *
 * With `what`, in a list's filter line, it speaks only for new filters that failed to load while the previous
 * rows stay (`previous` in lib/load-state.ts): "Could not load muted problems; showing the previous list", with
 * Try again. The page head then keeps saying when those rows were updated.
 */
export function RefreshNote({
  live,
  updated = false,
  separator = "",
  small = false,
  textClass = small ? "text-small" : "text-body",
  what,
}: {
  live: Live | Live[]
  updated?: boolean
  separator?: string
  /** In a small-text line, so Try again matches it. */
  small?: boolean
  /** The text size of the line it sits in, when that is neither body nor small text, so Try again matches it. */
  textClass?: string
  /** What the new filters would have shown, for a list's filter line. */
  what?: string
}) {
  const all = Array.isArray(live) ? live : [live]
  const failed = all.filter(what ? filterFailed : refreshFailed)
  // The oldest data on screen is the one the line speaks for.
  const at = failed.length ? Math.min(...failed.map((q) => q.dataUpdatedAt)) : all[0]?.dataUpdatedAt
  const fresh = updated && Boolean(at)
  return (
    <>
      {(failed.length > 0 || fresh) && separator}
      <span role="status" className="text-warn">
        {failed.length > 0 && (what ? `Could not load ${what}; showing the previous list` : "Could not refresh")}
      </span>
      {failed.length > 0 ? (
        <span className="text-warn">
          {at && !what ? (
            <>
              {" · "}
              <Updated at={at} />
            </>
          ) : null}{" "}
          <TryAgain
            className={textClass}
            busy={failed.some((q) => q.isFetching)}
            onClick={() => {
              for (const q of failed) void q.refetch()
            }}
          />
        </span>
      ) : fresh && at ? (
        <Updated at={at} />
      ) : null}
    </>
  )
}

/**
 * RefreshNote as a line of its own at the top of a panel whose title is outside it, such as a Settings form. It is
 * out of sight while the data is fresh but stays mounted, so a failure is announced when it comes (TB-5, LD-12).
 * With `what`, for a list with no filter line of its own, it also says when a new order or new filters failed to
 * load and the previous rows stay: "Could not load open problems; showing the previous list".
 */
export function RefreshLine({ live, what }: { live: Live; what?: string }) {
  const failed = refreshFailed(live) || (what !== undefined && filterFailed(live))
  return (
    <p className={cn("px-pad-x pt-3 text-small", !failed && "sr-only")}>
      <RefreshNote live={live} small />
      {what !== undefined && <RefreshNote live={live} what={what} small />}
    </p>
  )
}

/**
 * Try again after a failed load. While the new attempt runs it stays in place, named "Loading…" and marked busy,
 * so the keyboard focus stays on it, and is still on it when the attempt fails too (AX-6).
 */
export function TryAgain({
  busy = false,
  onClick,
  className,
}: {
  busy?: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <Button
      variant="link"
      className={className}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      onClick={() => {
        if (!busy) onClick()
      }}
    >
      {busy ? "Loading…" : "Try again"}
    </Button>
  )
}

/**
 * The base unit: a tinted panel. Rows inside it are split by a 1px top line only. A line kept out of sight at its
 * top (RefreshLine) does not count as the first row.
 */
export function Panel({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "min-w-0 overflow-hidden rounded-lg bg-panel regular:shadow-card regular:ring-1 regular:ring-ink/10 [&>:first-child]:border-t-0 [&>.sr-only:first-child+*]:border-t-0",
        className,
      )}
      {...props}
    />
  )
}

/** A panel header: a short noun, a muted count beside it, and a "more" link or an action on the far side. */
export function PanelHead({
  title,
  count,
  more,
  action,
  description,
  className,
  icon: Icon,
  tone,
}: {
  title: React.ReactNode
  count?: React.ReactNode
  more?: { to: string; label: string }
  action?: React.ReactNode
  description?: React.ReactNode
  className?: string
  /**
   * Makes the panel a summary card in Regular (#29): the title a small label, the count a large figure under it,
   * and this icon in a tile at the end. Compact keeps its one line head.
   */
  icon?: LucideIcon
  tone?: "warn"
}) {
  return (
    <header
      className={cn(
        "px-pad-x pt-[13px] pb-[9px] regular:pt-5 regular:pb-4",
        Icon && "regular:relative regular:pe-16 regular:pt-6",
        className,
      )}
    >
      {Icon && (
        <span
          aria-hidden
          className={cn(
            "absolute end-pad-x top-6 hidden size-9 place-items-center rounded-sm regular:grid",
            tone === "warn" ? "tint-warn" : "bg-fill text-muted-foreground",
          )}
        >
          <Icon className="size-4.5" />
        </span>
      )}
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-2.5 gap-y-2",
          Icon && "regular:flex-col regular:items-start regular:gap-y-1",
        )}
      >
        <h2 className={cn("text-head", Icon && "regular:text-body regular:font-normal regular:text-muted-foreground")}>
          {title}
        </h2>
        {count !== undefined && (
          <span
            className={cn(
              "font-medium text-muted-foreground tabular-nums",
              Icon && "regular:text-figure regular:text-ink",
            )}
          >
            {count}
          </span>
        )}
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
      {description && (
        <p className="mt-0.5 text-small text-muted-foreground regular:mt-1 regular:text-body">{description}</p>
      )}
    </header>
  )
}

/**
 * A row that is a link. A drag over it selects its text instead of dragging the link, and a click that ends
 * selecting text goes nowhere, so its values can be copied; a plain click and Enter follow the link (TB-8).
 */
export function RowLink({ onClick, ...props }: React.ComponentProps<typeof Link>) {
  return (
    <Link
      draggable={false}
      onClick={(e) => {
        if (rowHeld(e)) e.preventDefault()
        else onClick?.(e)
      }}
      {...props}
    />
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
  /** A 3px status edge at the start; healthy rows keep it quiet. Regular has no edges: its tags carry status. */
  edge?: "ok" | "warn" | "fail" | "info" | "muted"
  children: React.ReactNode
}) {
  const cls = cn(
    "flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-line px-pad-x py-pad-y",
    (to || onClick) && "hover-row",
    current && "bg-accent",
    edge && "border-s-3 regular:border-s-0",
    edge === "ok" && "border-s-ok/55",
    edge === "warn" && "border-s-warn",
    edge === "fail" && "border-s-fail",
    edge === "info" && "border-s-info",
    edge === "muted" && "border-s-muted-foreground/40",
    className,
  )
  if (to)
    return (
      <RowLink to={to} className={cls} aria-current={current ? "page" : undefined}>
        {children}
      </RowLink>
    )
  if (onClick)
    return (
      <button
        type="button"
        onClick={(e) => !rowHeld(e) && onClick()}
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

/** An alert row: a 4px status bar (Compact; Regular's tag carries the status), the text, one action. */
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
          "w-1 shrink-0 self-stretch rounded-e-kbd regular:hidden",
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
  const cls = "flex items-start gap-3.5 border-t border-line pe-pad-x regular:ps-pad-x"
  if (to)
    return (
      <RowLink to={to} className={cn(cls, "hover-row")}>
        {body}
      </RowLink>
    )
  return <div className={cls}>{body}</div>
}

/**
 * Key figures: a large number with a muted label. Compact draws one outlined block (cell lines are outlines,
 * so a short last row leaves no block); Regular draws a card per figure with its icon.
 */
export function Kpis({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] overflow-hidden rounded-lg border border-line bg-bg",
        "regular:gap-gap regular:overflow-visible regular:border-0 regular:bg-transparent",
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
  icon: Icon,
}: {
  label: React.ReactNode
  /** A number is formatted the same way everywhere (and rolls in, in Regular). */
  value: React.ReactNode | number
  hint?: React.ReactNode
  tone?: "fail" | "warn" | "ok"
  /** Every count is a link to the list it counts. */
  to?: string
  /** What the figure is about; drawn by Regular only, beside the figure. */
  icon?: LucideIcon
}) {
  const inner = (
    <>
      <span className="flex min-w-0 flex-col">
        <b
          data-slot="kpi-figure"
          className={cn(
            "block text-figure tabular-nums",
            // Words ("just now", "14 h ago") a size down in Regular, so they fit a narrow card on one line.
            typeof value !== "number" && "regular:text-h1",
            tone === "fail" && "text-fail",
            tone === "warn" && "text-warn",
            tone === "ok" && "text-ok",
          )}
        >
          {typeof value === "number" ? <Figure value={value} /> : value}
        </b>
        <span className="block text-small text-muted-foreground regular:-order-1 regular:mb-1">{label}</span>
        {hint && <span className="mt-0.5 block text-meta text-muted-foreground">{hint}</span>}
      </span>
      {Icon && (
        <span
          aria-hidden
          data-slot="kpi-icon"
          className={cn(
            "hidden size-9 shrink-0 place-items-center rounded-sm regular:md:grid",
            !tone && "bg-fill text-muted-foreground",
            tone === "fail" && "tint-fail",
            tone === "warn" && "tint-warn",
            tone === "ok" && "tint-ok",
          )}
        >
          <Icon className="size-4.5" />
        </span>
      )}
    </>
  )
  const cls = cn(
    "flex min-w-0 items-start justify-between gap-3 px-pad-x py-[11px] outline outline-line",
    "regular:rounded-lg regular:bg-panel regular:p-5 regular:shadow-card regular:ring-1 regular:ring-ink/10 regular:outline-0",
  )
  return to ? (
    <Link to={to} data-slot="kpi" className={cn(cls, "hover-row")}>
      {inner}
    </Link>
  ) : (
    <div data-slot="kpi" className={cls}>
      {inner}
    </div>
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
  icon,
  className,
}: {
  title: React.ReactNode
  children?: React.ReactNode
  action?: React.ReactNode
  /** Drawn by Regular only, above the sentence; the page's own icon when not given. */
  icon?: LucideIcon
  className?: string
}) {
  const { pathname } = useLocation()
  const Icon = icon ?? pageOf(pathname)?.item.icon ?? Inbox
  return (
    <div
      className={cn(
        "px-pad-x py-9 text-center text-muted-foreground",
        "regular:m-pad-x regular:rounded-lg regular:border regular:border-dashed regular:border-line regular:py-10",
        className,
      )}
    >
      <span
        aria-hidden
        className="mx-auto mb-3 hidden size-11 place-items-center rounded-full bg-fill ring-8 ring-fill/40 regular:grid"
      >
        <Icon className="size-5" />
      </span>
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
 * matters, and links to where it is set ("Settings → Backup Storage").
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
 * An ID, address or key in mono that copies on click: a faint background and a copy icon, faint at rest and
 * full on hover, the full value copied (not the truncated one), a check for 1.5s and a toast that says what was
 * copied.
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
  const { done, copy } = useCopy(value)
  const Icon = done ? Check : Copy
  return (
    <button
      type="button"
      data-copy
      onClick={copy}
      title={value}
      aria-label={`${label ?? "Copy"}: ${value}`}
      className={cn(
        "group/copy inline-flex max-w-full min-w-0 items-center gap-1 rounded-tag px-1 -mx-1 text-start font-mono text-code transition-colors duration-150 [@media(hover:hover)]:hover:bg-ink/6",
        className,
      )}
    >
      <span className="min-w-0 truncate" dir="auto">
        {children ?? value}
      </span>
      <Icon
        aria-hidden
        className={cn(
          // Faint at rest so the value says it copies without a hover; full on hover and keyboard focus.
          "size-3.5 shrink-0 text-muted-foreground opacity-50 transition-opacity duration-150 group-hover/copy:opacity-100 group-focus-visible/copy:opacity-100",
          done && "text-ok opacity-100",
        )}
      />
    </button>
  )
}

/** Copies a value: a check for 1.5s and a toast that says what was copied. */
function useCopy(value: string) {
  const [done, setDone] = useState(false)
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    try {
      await navigator.clipboard.writeText(value)
      setDone(true)
      setTimeout(() => setDone(false), COPIED_MS)
      toast.success(`Copied: ${value.length > 80 ? `${value.slice(0, 80)}…` : value}`)
    } catch {
      toast.error("Could not copy. Select the text and copy it instead.")
    }
  }
  return { done, copy }
}

/**
 * A command or text to paste somewhere else, in full: it wraps instead of being cut, reads left to right,
 * can be selected by hand, and has its own Copy button.
 */
export function Command({
  value,
  label,
}: {
  value: string
  /** The Copy button's accessible name ("Copy the command"). */
  label: string
}) {
  const { done, copy } = useCopy(value)
  return (
    <div className="flex w-full min-w-0 items-start gap-2 rounded-sm border border-line bg-fill py-1.5 ps-3 pe-1.5">
      <code dir="ltr" className="min-w-0 flex-1 py-1 font-mono text-small whitespace-pre-wrap wrap-anywhere select-all">
        {value}
      </code>
      <Button size="sm" onClick={copy} aria-label={label} className="shrink-0">
        {done ? <Check className="text-ok" /> : <Copy />}
        {done ? "Copied" : "Copy"}
      </Button>
    </div>
  )
}

/**
 * A button that starts a request (FB-7, DS-20). With `run` it owns the request: a click sends one, and clicks
 * are ignored until its label is back (its clock is lib/busy-run.ts, so a double click cannot send two). It is
 * disabled and shows a spinning ring and `busyLabel` ("Checking…") meanwhile; then "Done" for DONE_MS, or
 * "Failed" for FAILED_MS, and its label again. `run` should reject on failure and say why itself (useApiMutation's
 * toast).
 * With `busy` instead, the caller owns the state (a dialog's submit, whose dialog says the result): the ring and
 * `busyLabel` show while it is true.
 */
export function BusyButton({
  run,
  busy: held = false,
  busyLabel,
  icon: Icon,
  labelClassName,
  children,
  disabled,
  variant,
  className,
  onClick,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "children" | "asChild"> & {
  run?: () => Promise<unknown>
  busy?: boolean
  busyLabel: string
  icon?: LucideIcon
  /** For a label that hides in a narrow pane but stays the accessible name (`@max-[34rem]/pane:sr-only`). */
  labelClassName?: string
  children: React.ReactNode
}) {
  const [state, setState] = useState<BusyState>("idle")
  const [clock] = useState(() => busyRun(setState))
  useEffect(() => clock.mount(), [clock])
  const busy = held || state === "busy"
  const Shown = busy ? LoaderCircle : state === "done" ? Check : state === "failed" ? X : Icon
  // A filled button keeps its colours; the others take the result's tone.
  const toned = variant !== "primary" && variant !== "danger-solid"
  return (
    <Button
      {...props}
      variant={variant}
      // "Done" stays undimmed but, like "Failed", ignores clicks (`clock.ignore`): it is not the action, and a
      // quick answer cannot turn a double click into two requests.
      disabled={disabled || busy || state === "failed"}
      className={cn(
        toned && state === "done" && "border-ok/40 text-ok",
        toned && state === "failed" && "border-fail/40 text-fail",
        className,
      )}
      onClick={(e) => {
        // Until its label is back a click does nothing: it neither opens the row the button sits in nor submits.
        if (clock.ignore(e)) return
        onClick?.(e)
        if (run && !e.defaultPrevented) void clock.start(run)
      }}
    >
      {Shown && <Shown aria-hidden className={cn(busy && "animate-spin")} />}
      <span className={labelClassName}>
        {busy ? busyLabel : state === "done" ? "Done" : state === "failed" ? "Failed" : children}
      </span>
    </Button>
  )
}

/** User-entered text (workflow, instance and token names) keeps its own direction. */
export function UserText({
  children,
  className,
  title,
}: {
  children: React.ReactNode
  className?: string
  /** The full text on hover, where `className` cuts it to one line (TB-15). */
  title?: string
}) {
  return (
    <span dir="auto" className={className} title={title}>
      <bdi>{children}</bdi>
    </span>
  )
}

/** A muted "-" where there is nothing to measure or nothing was recorded, never a made-up 0 (FB-8). */
export function NoValue() {
  return <span className="text-muted-foreground">-</span>
}

export {
  countChanges,
  type FieldProblem,
  formChanged,
  SaveBarHost,
  SaveScope,
  useSaveSource,
  useUnsaved,
  useUnsavedIds,
} from "@/components/save-bar"

/**
 * A list that reloads keeps its rows on screen until the answer replaces them; they dim only when the
 * answer takes longer than 200ms, so a fast reload does not flicker and nothing collapses (TB-5). A reload that
 * fails keeps them too (`loadView` in lib/load-state.ts), and the page head says so (RefreshNote).
 */
export function Reloading({
  busy,
  children,
  className,
}: {
  busy: boolean
  children: React.ReactNode
  className?: string
}) {
  const [dim, setDim] = useState(false)
  useEffect(() => {
    if (!busy) {
      setDim(false)
      return
    }
    const timer = setTimeout(() => setDim(true), DIM_AFTER_MS)
    return () => clearTimeout(timer)
  }, [busy])
  return (
    <div
      aria-busy={busy || undefined}
      className={cn("grid min-w-0 transition-opacity duration-150", dim && "opacity-60", className)}
    >
      {children}
    </div>
  )
}

/**
 * An on/off setting: the whole row, title and description included, is the label of its switch, so a click
 * anywhere on it flips the switch (FS-1). A switch that cannot be used says why in `reason`, shown under the
 * description, as a tip alone never shows by touch or keyboard (AX-9).
 */
export function SwitchRow({
  id,
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
  reason,
  className,
}: {
  id: string
  title: React.ReactNode
  description?: React.ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  reason?: string
  className?: string
}) {
  return (
    <label
      htmlFor={id}
      className={cn("flex min-w-0 items-center gap-4", disabled ? "cursor-not-allowed" : "cursor-pointer", className)}
    >
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{title}</span>
        {description && <span className="mt-0.5 block text-small text-muted-foreground">{description}</span>}
        {disabled && reason && <span className="mt-0.5 block text-small text-muted-foreground">{reason}</span>}
      </span>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </label>
  )
}

/**
 * A stored secret is never shown as a masked field (FS-3). It reads "Stored" with Replace and Remove; the
 * password field appears only on Replace and takes the focus, and Remove marks it "Removed when you save".
 * The value is `undefined` while unchanged (and is then not sent), a string when replaced, `null` to remove.
 */
export function SecretField({
  id,
  stored,
  value,
  onChange,
  removable = true,
  placeholder = "Not set",
  invalid,
  describedBy,
}: {
  id: string
  stored: boolean
  value: string | null | undefined
  onChange: (value: string | null | undefined) => void
  removable?: boolean
  placeholder?: string
  /** The field failed its check before a save, and the note that says why (SV-1). */
  invalid?: boolean
  describedBy?: string
}) {
  if (!stored || typeof value === "string")
    return (
      <div className="flex w-full min-w-0 items-center gap-2">
        <Input
          id={id}
          type="password"
          autoComplete="new-password"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          // Focus moves into the field the moment Replace is chosen.
          autoFocus={stored}
          placeholder={stored ? "New value" : placeholder}
          value={value ?? ""}
          onChange={(e) => onChange(stored || e.target.value ? e.target.value : undefined)}
        />
        {stored && (
          <Button size="sm" variant="ghost" onClick={() => onChange(undefined)}>
            Keep
          </Button>
        )}
      </div>
    )
  return (
    <div className="flex min-h-ctl w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      {value === null ? (
        <span id={id} className="font-semibold text-fail">
          Removed when you save
        </span>
      ) : (
        <span id={id} className="font-semibold">
          Stored
        </span>
      )}
      <span className="ms-auto flex gap-1.5">
        {value === null ? (
          <Button size="sm" onClick={() => onChange(undefined)}>
            Keep
          </Button>
        ) : (
          <>
            <Button size="sm" onClick={() => onChange("")}>
              Replace
            </Button>
            {removable && (
              <Button size="sm" variant="danger" onClick={() => onChange(null)}>
                Remove
              </Button>
            )}
          </>
        )}
      </span>
    </div>
  )
}

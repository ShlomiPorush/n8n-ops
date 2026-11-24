import { Check, Copy, Inbox, Loader2, LoaderCircle, Lock, type LucideIcon, X } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useLocation } from "react-router"
import { PageActions, useTopBar } from "@/app/chrome"
import { pageOf } from "@/app/nav"
import { PageIcon, PageTitle } from "@/components/skin/page-title"
import { timeAgo, useTick } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tip, TipInControl } from "@/components/ui/tooltip"
import { describeError } from "@/lib/api"
import { COPIED_MS, DIM_AFTER_MS } from "@/lib/behavior"
import { type BusyState, busyRun } from "@/lib/busy-run"
import { filterFailed, type Live, refreshFailed } from "@/lib/load-state"
import { n } from "@/lib/numbers"
import { rowHeld } from "@/lib/row-held"
import { formatTime, useTimeFormat } from "@/lib/time"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"

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
        <h1 className="min-w-0 flex-1 text-h1 font-heavy break-words regular:tracking-tighter compact:max-[381px]:text-h1-narrow">
          {title}
        </h1>
        {actions && (
          <div className="flex shrink-0 items-center gap-2 compact:[&>*>svg:not([data-status])]:hidden">{actions}</div>
        )}
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

function Updated({ at }: { at: number }) {
  useTick()
  const w = useTimeFormat()
  return (
    <Tip content={formatTime(at, w)}>
      <span>Updated {timeAgo(new Date(at))}</span>
    </Tip>
  )
}

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
  small?: boolean
  textClass?: string
  what?: string
}) {
  const all = Array.isArray(live) ? live : [live]
  const failed = all.filter(what ? filterFailed : refreshFailed)
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

export function RefreshLine({ live, what }: { live: Live; what?: string }) {
  const failed = refreshFailed(live) || (what !== undefined && filterFailed(live))
  return (
    <p className={cn("px-pad-x pt-3 text-small", !failed && "sr-only")}>
      <RefreshNote live={live} small />
      {what !== undefined && <RefreshNote live={live} what={what} small />}
    </p>
  )
}

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

export function Panel({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "min-w-0 overflow-clip rounded-lg bg-panel regular:shadow-card regular:ring-1 regular:ring-ink/10 [&>:first-child]:border-t-0 [&>.sr-only:first-child+*]:border-t-0",
        className,
      )}
      {...props}
    />
  )
}

export function PanelHead({
  title,
  count,
  more,
  action,
  sort,
  description,
  className,
  icon: Icon,
  tone,
}: {
  title: React.ReactNode
  count?: React.ReactNode
  more?: { to: string; label: string }
  action?: React.ReactNode
  sort?: React.ReactNode
  description?: React.ReactNode
  className?: string
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
          <span className={cn("font-medium text-muted-foreground", Icon && "regular:text-figure regular:text-ink")}>
            {count}
          </span>
        )}
        {(more || action || sort) && (
          <div className="ms-auto flex items-center gap-2">
            {action}
            {more && (
              <Link to={more.to} className="text-ctl font-semibold underline">
                {more.label}
              </Link>
            )}
            {sort}
          </div>
        )}
      </div>
      {description && (
        <p className="mt-0.5 text-small text-muted-foreground regular:mt-1 regular:text-body">{description}</p>
      )}
    </header>
  )
}

export function RowLink({ onClick, children, ...props }: React.ComponentProps<typeof Link>) {
  return (
    <Link
      draggable={false}
      onClick={(e) => {
        if (rowHeld(e)) e.preventDefault()
        else onClick?.(e)
      }}
      {...props}
    >
      <TipInControl>{children}</TipInControl>
    </Link>
  )
}

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
        <TipInControl>{children}</TipInControl>
      </button>
    )
  return <div className={cls}>{children}</div>
}

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
      <span className="ms-auto min-w-0 text-end font-title break-words">{children}</span>
    </div>
  )
}

export function AlertRow({
  tone,
  title,
  children,
  actions,
  to,
  onOpen,
}: {
  tone: "fail" | "warn" | "info" | "muted"
  title: React.ReactNode
  children?: React.ReactNode
  actions?: React.ReactNode
  to?: string
  onOpen?: React.MouseEventHandler<HTMLAnchorElement>
}) {
  const text = (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">{title}</div>
      {children && <div className="mt-0.5 text-small break-words text-muted-foreground">{children}</div>}
    </>
  )
  return (
    // biome-ignore lint/a11y: the link inside is the row's keyboard and screen reader path; this only widens its pointer target
    <div
      data-slot="alert-row"
      className={cn(
        "grid grid-cols-[4px_minmax(0,1fr)_auto] items-start gap-x-3.5 border-t border-line pe-pad-x",
        "regular:grid-cols-[minmax(0,1fr)_auto] regular:ps-pad-x",
        "@max-[32rem]/alerts:grid-cols-[4px_minmax(0,1fr)] regular:@max-[32rem]/alerts:grid-cols-[minmax(0,1fr)]",
        to && "hover-row",
      )}
      onClick={(e) => {
        if (!to || rowHeld(e) || (e.target as Element).closest("a, button")) return
        e.currentTarget.querySelector<HTMLAnchorElement>('[data-slot="alert-link"]')?.click()
      }}
    >
      <span
        aria-hidden
        className={cn(
          "w-1 self-stretch rounded-e-kbd regular:hidden @max-[32rem]/alerts:row-span-2",
          tone === "fail" && "bg-fail",
          tone === "warn" && "bg-warn",
          tone === "info" && "bg-info",
          tone === "muted" && "bg-muted-foreground/40",
        )}
      />
      {to ? (
        <RowLink
          to={to}
          data-slot="alert-link"
          onClick={onOpen}
          className="block min-w-0 py-pad-y outline-offset-[-2px]"
        >
          {text}
        </RowLink>
      ) : (
        <div className="min-w-0 py-pad-y">{text}</div>
      )}
      {actions && (
        <div className="flex flex-wrap items-center gap-2 self-center py-2 @max-[32rem]/alerts:col-start-2 @max-[32rem]/alerts:self-start @max-[32rem]/alerts:pt-0 @max-[32rem]/alerts:pb-pad-y regular:@max-[32rem]/alerts:col-start-1">
          {actions}
        </div>
      )}
    </div>
  )
}

export function Kpis({
  className,
  row = false,
  children,
}: {
  className?: string
  row?: boolean
  children: React.ReactNode
}) {
  const grid = (
    <div
      className={cn(
        "grid overflow-clip rounded-lg border border-line bg-bg",
        row
          ? kpiRow
          : "grid-cols-[repeat(auto-fit,minmax(170px,1fr))] compact:grid-cols-[repeat(auto-fit,minmax(150px,1fr))] max-md:grid-cols-2 compact:max-md:grid-cols-2 max-md:[&>:last-child:nth-child(odd)]:col-span-full",
        "regular:gap-gap regular:overflow-visible regular:border-0 regular:bg-transparent",
        className,
      )}
    >
      {children}
    </div>
  )
  return row ? <div className="@container/kpis min-w-0">{grid}</div> : grid
}

const kpiRow = cn(
  "grid-flow-col auto-cols-fr",
  "@max-[40rem]/kpis:**:data-[slot=kpi-icon]:hidden!",
  // One plain class for both designs would lose to Regular's larger size for a figure in words.
  "compact:@max-[30rem]/kpis:**:data-[slot=kpi-figure]:text-h2",
  "regular:@max-[30rem]/kpis:**:data-[slot=kpi-figure]:text-h2",
  "regular:@max-[30rem]/kpis:gap-2 regular:@max-[30rem]/kpis:**:data-[slot=kpi]:p-3",
  "compact:@max-[30rem]/kpis:**:data-[slot=kpi]:px-3",
)

export function Kpi({
  label,
  value,
  hint,
  tone,
  to,
  icon: Icon,
}: {
  label: React.ReactNode
  value: React.ReactNode | number
  hint?: React.ReactNode
  tone?: "fail" | "warn" | "ok"
  to?: string
  icon?: LucideIcon
}) {
  const inner = (
    <>
      <span className="flex min-w-0 flex-col">
        <b
          data-slot="kpi-figure"
          className={cn(
            "block text-figure",
            typeof value !== "number" && "regular:text-h1",
            tone === "fail" && "text-fail",
            tone === "warn" && "text-warn",
            tone === "ok" && "text-ok",
          )}
        >
          {typeof value === "number" ? n(value) : value}
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
      <TipInControl>{inner}</TipInControl>
    </Link>
  ) : (
    <div data-slot="kpi" className={cls}>
      {inner}
    </div>
  )
}

export function FigureTabs({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <nav aria-label={label} className="flex min-w-0 gap-5 overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
      {children}
    </nav>
  )
}

export function FigureTab({
  label,
  value,
  tone,
  to,
  selected,
}: {
  label: string
  value: number
  tone?: "fail" | "warn"
  to: string
  selected: boolean
}) {
  return (
    <Link
      to={to}
      data-slot="figure-tab"
      aria-current={selected ? "true" : undefined}
      className={cn(
        "inline-flex shrink-0 items-baseline gap-1.5 border-b-2 border-transparent pt-1 pb-2 text-ctl font-semibold whitespace-nowrap text-muted-foreground transition-colors duration-150 hover:text-ink focus-visible:-outline-offset-2",
        selected && "border-primary text-ink",
      )}
    >
      <b
        data-slot="kpi-figure"
        className={cn("text-h2", tone === "fail" && "text-fail", tone === "warn" && "text-warn")}
      >
        {n(value)}
      </b>
      <span>{label}</span>
    </Link>
  )
}

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

export function Copyable({
  value,
  children,
  className,
  label,
  wrap = false,
}: {
  value: string
  children?: React.ReactNode
  className?: string
  label?: string
  wrap?: boolean
}) {
  const { done, copy } = useCopy(value)
  const Icon = done ? Check : Copy
  return (
    <button
      type="button"
      data-copy
      onClick={copy}
      title="Click to copy"
      aria-label={`${label ?? "Copy"}: ${value}`}
      className={cn(
        "group/copy inline-flex max-w-full min-w-0 gap-1 rounded-tag px-1 -mx-1 text-start font-mono transition-colors duration-150 [@media(hover:hover)]:hover:bg-copy-hover",
        wrap ? "items-end" : "items-center",
        className,
      )}
    >
      <span className={cn("min-w-0 select-text", wrap ? "wrap-anywhere" : "truncate")} dir="auto">
        {children ?? value}
      </span>
      <Icon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 group-focus-visible/copy:opacity-100 [@media(hover:hover)]:group-hover/copy:opacity-50",
          done && "text-ok opacity-100",
        )}
      />
    </button>
  )
}

function useCopy(value: string) {
  const [done, setDone] = useState(false)
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    if (!window.isSecureContext || !navigator.clipboard) {
      toast.error("Copying needs HTTPS. Select the text and copy it instead.")
      return
    }
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

export function Command({ value, label }: { value: string; label: string }) {
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
  labelClassName?: string
  children: React.ReactNode
}) {
  const [state, setState] = useState<BusyState>("idle")
  const [clock] = useState(() => busyRun(setState))
  const busy = held || state === "busy"
  const Shown = busy ? LoaderCircle : state === "done" ? Check : state === "failed" ? X : Icon
  const toned = variant !== "primary" && variant !== "danger-solid"
  return (
    <Button
      {...props}
      variant={variant}
      disabled={disabled || busy || state === "failed"}
      className={cn(
        toned && state === "done" && "border-ok/40 text-ok",
        toned && state === "failed" && "border-fail/40 text-fail",
        className,
      )}
      onClick={(e) => {
        if (clock.ignore(e)) return
        onClick?.(e)
        if (run && !e.defaultPrevented) void clock.start(run)
      }}
    >
      {Shown && (
        <Shown aria-hidden data-status={Shown === Icon ? undefined : ""} className={cn(busy && "animate-spin")} />
      )}
      <span className={labelClassName}>
        {busy ? busyLabel : state === "done" ? "Done" : state === "failed" ? "Failed" : children}
      </span>
    </Button>
  )
}

export function UserText({
  children,
  className,
  title,
}: {
  children: React.ReactNode
  className?: string
  title?: string
}) {
  return (
    <span dir="auto" className={className} title={title}>
      <bdi>{children}</bdi>
    </span>
  )
}

export function NoValue({ said = "Not recorded" }: { said?: string }) {
  return (
    <span className="text-muted-foreground">
      <span aria-hidden="true">-</span>
      <span className="sr-only">{said}</span>
    </span>
  )
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

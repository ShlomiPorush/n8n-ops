import { useQueryClient } from "@tanstack/react-query"
import {
  ChevronRight,
  Ellipsis,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  Sun,
  UserRound,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Popover as PopoverPrimitive, Dialog as SheetPrimitive } from "radix-ui"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate, useNavigationType } from "react-router"
import { ChromeContext } from "@/app/chrome"
import { DesignSync } from "@/app/design-sync"
import { groups, isActive, type NavItem, operate, pageGroups, pageOf } from "@/app/nav"
import { GlobalSearch, PhoneSearch, type SearchPage } from "@/app/search"
import { settingsGroups } from "@/app/settings-sections"
import { SaveScope } from "@/components/save-bar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useMediaQuery } from "@/hooks/use-mobile"
import { ApiError, useApi } from "@/lib/api"
import { authClient } from "@/lib/auth-client"
import { useLiveUpdates } from "@/lib/live"
import { useOverlayHistory } from "@/lib/overlay-history"
import { n, plural } from "@/lib/time"
import { cn } from "@/lib/utils"

/** The phone tab bar: the four pages used most; every page is in the More sheet. */
const tabs = operate.slice(0, 4)
/** Every page, for the search. */
const searchPages: SearchPage[] = pageGroups.flatMap((g) =>
  g.items.map((i) => ({ to: i.to, label: i.label, group: g.label })),
)

type Summary = { openProblems: number; pendingAccess: number; workers: { online: number; total: number } }
type Me = { twoFactor: boolean }

/** Signed-in area: redirects to login or to two-factor setup when needed. */
export function RequireAuth() {
  const me = useApi<Me>("/setup/checklist")
  const { pathname, search } = useLocation()
  if (me.isLoading) return null
  if (me.error instanceof ApiError && me.error.status === 401)
    // Back to this page after signing in (NL-18).
    return (
      <Navigate to={pathname === "/" ? "/login" : `/login?next=${encodeURIComponent(pathname + search)}`} replace />
    )
  if (me.data && !me.data.twoFactor) return <Navigate to="/setup" replace />
  return <Outlet />
}

/** How many things on this page wait for action, and how urgent they are. Nothing when there is nothing to do. */
function useCounts() {
  const summary = useApi<Summary>("/overview/summary", { refetchInterval: 30_000 })
  const s = summary.data
  return {
    summary: s,
    of(item: NavItem): { value: number; tone: "fail" | "warn"; says: string } | null {
      if (item.count === "problems" && s?.openProblems)
        return { value: s.openProblems, tone: "fail", says: plural(s.openProblems, "open problem") }
      if (item.count === "access" && s?.pendingAccess)
        return {
          value: s.pendingAccess,
          tone: "warn",
          says: plural(s.pendingAccess, "access request waits", "access requests wait"),
        }
      return null
    },
  }
}

function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-[30px] shrink-0 place-items-center rounded-sm bg-primary text-ctl font-heavy text-primary-foreground",
        className,
      )}
    >
      n
    </span>
  )
}

/*
 * The sidebar folds into a 72px icon rail and remembers it in this browser (NL-7). The choice is applied by
 * a script in index.html before the page draws, so a folded sidebar never flashes open. Ctrl+B (Cmd+B on a
 * Mac) folds and unfolds it where the full sidebar exists, above 1100px.
 */
const NAV_KEY = "n8n-ops-nav"
function useNavFolded() {
  const [folded, setFolded] = useState(() => document.documentElement.dataset.nav === "rail")
  const toggle = useCallback(() => {
    setFolded((f) => {
      const next = !f
      if (next) document.documentElement.dataset.nav = "rail"
      else delete document.documentElement.dataset.nav
      try {
        localStorage.setItem(NAV_KEY, next ? "rail" : "side")
      } catch {
        // Private mode: the choice lasts for this visit only.
      }
      return next
    })
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "b" || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      if (!window.matchMedia("(min-width: 1101px)").matches) return
      e.preventDefault()
      toggle()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [toggle])
  return { folded, toggle }
}

function NavToggle({ folded, toggle, className }: { folded: boolean; toggle: () => void; className?: string }) {
  const label = folded ? "Expand menu" : "Collapse menu"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          aria-label={label}
          aria-expanded={!folded}
          onClick={toggle}
          className={cn("aria-expanded:border-transparent", className)}
        >
          {folded ? <PanelLeftOpen /> : <PanelLeftClose />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {label} <kbd className="font-mono">{/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘B" : "Ctrl+B"}</kbd>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The top bar from 761px (NL-6): the brand above the sidebar, then the trail "Group › Page › opened item"
 * with the page title, and the page's own actions at the far end. The trail also names the browser tab.
 */
function TopBar({
  crumb,
  nav,
  setActionsSlot,
}: {
  crumb: string | null
  nav: ReturnType<typeof useNavFolded>
  setActionsSlot: (el: HTMLDivElement | null) => void
}) {
  const { pathname } = useLocation()
  const page = pageOf(pathname)
  const atRoot = page && (pathname === page.item.to || pathname === `${page.item.to}/`)
  // While the search is in use it widens and the page buttons step aside (SR-2).
  const [searching, setSearching] = useState(false)
  return (
    // A subgrid of the shell: the brand above the sidebar's column, the bar above the page's.
    <header className="hidden h-bar border-b border-line bg-bg md:col-span-2 md:col-start-1 md:row-start-1 md:grid md:grid-cols-subgrid regular:h-16 regular:border-b-0 regular:bg-transparent">
      <div className="flex h-full min-w-0 items-center justify-center gap-2.5 border-e border-line bg-side side:justify-start side:ps-[18px] side:pe-2.5 regular:border-e-0 regular:bg-transparent">
        <Link to="/" aria-label="n8n-ops, Overview" className="flex shrink-0 rounded-sm">
          <BrandMark />
        </Link>
        <span className="hidden min-w-0 flex-1 side:block">
          <span className="block truncate text-head font-bold tracking-tight">n8n-ops</span>
          <span className="block truncate text-meta text-muted-foreground">Operations console</span>
        </span>
        <NavToggle {...nav} className="hidden compact:side:inline-flex" />
      </div>
      <div className="flex h-full min-w-0 items-center regular:mt-2 regular:me-2 regular:h-auto regular:border-b regular:border-line">
        {/* Regular folds the sidebar from the start of the bar, behind a short divider (#29). */}
        <NavToggle {...nav} className="ms-3 hidden regular:lg:inline-flex" />
        <span aria-hidden className="ms-2 hidden h-4 w-px shrink-0 bg-line regular:lg:block" />
        <nav
          aria-label="You are here"
          className="flex h-full min-w-0 flex-1 items-center px-[22px] lg:px-7 regular:lg:ps-3.5"
        >
          <ol className="flex min-w-0 items-center gap-2">
            {page && (
              <li className="hidden shrink-0 items-center gap-2 text-small font-semibold text-muted-foreground compact:lg:flex">
                {page.group}
                <ChevronRight aria-hidden className="size-3.5" />
              </li>
            )}
            <li className="min-w-0 shrink-0">
              <h1 className="truncate text-title font-heavy tracking-tighter regular:text-body regular:font-medium regular:tracking-normal">
                {page && !atRoot && crumb ? (
                  <Link to={page.item.to} className="underline-offset-3 [@media(hover:hover)]:hover:underline">
                    {page.item.label}
                  </Link>
                ) : (
                  <span aria-current={crumb ? undefined : "page"}>{page?.item.label ?? "n8n-ops"}</span>
                )}
              </h1>
            </li>
            {crumb && (
              <li className="flex min-w-0 items-center gap-2">
                <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span aria-current="page" className="truncate text-body font-semibold" dir="auto">
                  <bdi>{crumb}</bdi>
                </span>
              </li>
            )}
          </ol>
        </nav>
        <div
          ref={setActionsSlot}
          className={cn("flex shrink-0 items-center gap-2 pe-3 empty:hidden", searching && "hidden")}
        />
        <GlobalSearch pages={searchPages} variant="bar" onOpenChange={setSearching} className="me-[22px] lg:me-7" />
      </div>
    </header>
  )
}

/**
 * The pages of Settings beside its sidebar item, on hover or with the right arrow key (NL-8). Only where
 * there is a pointer; touch screens use the page's own section list.
 */
function SectionsFlyout({ children, label }: { children: React.ReactElement; label: string }) {
  const [open, setOpen] = useState(false)
  const byKey = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const pointer = useMediaQuery("(hover: hover)")
  const { pathname } = useLocation()
  // biome-ignore lint/correctness/useExhaustiveDependencies: a chosen section closes the menu
  useEffect(() => setOpen(false), [pathname])
  if (!pointer) return children
  const show = () => {
    clearTimeout(timer.current)
    setOpen(true)
  }
  const hide = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(false), 150)
  }
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Anchor asChild>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: hover and arrow keys open the menu of the link inside */}
        <div
          onPointerEnter={show}
          onPointerLeave={hide}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") {
              e.preventDefault()
              byKey.current = true
              setOpen(true)
            }
          }}
        >
          {children}
        </div>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          aria-label={`${label} sections`}
          onPointerEnter={show}
          onPointerLeave={hide}
          onOpenAutoFocus={(e) => {
            // Focus moves into the menu only when it was opened from the keyboard.
            if (!byKey.current) e.preventDefault()
            byKey.current = false
          }}
          onKeyDown={(e) => {
            const links = [...e.currentTarget.querySelectorAll<HTMLElement>("a")]
            const at = links.indexOf(document.activeElement as HTMLElement)
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault()
              const step = e.key === "ArrowDown" ? 1 : -1
              links[(at + step + links.length) % links.length]?.focus()
            } else if (e.key === "ArrowLeft") {
              e.preventDefault()
              setOpen(false)
            }
          }}
          className="relative z-60 grid w-[210px] gap-0.5 rounded-lg bg-popover p-1.5 text-popover-foreground shadow-float outline-none before:absolute before:inset-y-0 before:-start-3 before:w-3 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-left-1"
        >
          <b className="px-2.5 pt-1 pb-0.5 text-small text-muted-foreground">{label}</b>
          {settingsGroups.flatMap((g) =>
            g.items.map(([key, name]) => (
              <NavLink
                key={key}
                to={`/settings/${key}`}
                className="flex min-h-8 items-center gap-2 rounded-sm px-2.5 text-body outline-none focus-visible:outline-offset-[-2px] aria-[current=page]:font-bold [@media(hover:hover)]:hover:bg-accent"
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    pathname === `/settings/${key}` ? "bg-ink" : "bg-transparent",
                  )}
                />
                {name}
              </NavLink>
            )),
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

function SideNav({ nav }: { nav: ReturnType<typeof useNavFolded> }) {
  const { pathname } = useLocation()
  const counts = useCounts()
  const workers = counts.summary?.workers
  return (
    <nav
      aria-label="Main"
      className="hidden min-h-0 flex-col items-center gap-0.5 overflow-y-auto border-e border-line bg-side px-2.5 py-3.5 md:col-start-1 md:row-start-2 md:flex side:items-stretch regular:border-e-0 regular:bg-transparent"
    >
      {/* Folded on a wide screen, the toggle sits at the top of the rail (Regular keeps it in the bar). */}
      <NavToggle {...nav} className="mb-2 hidden compact:folded:inline-flex" />

      {/* Compact shows how the workers are doing at the top of the sidebar, Regular at its foot (#29). */}
      <WorkersStatus
        workers={workers}
        className="mx-1 mb-3 hidden bg-fill py-2.5 compact:side:flex [@media(hover:hover)]:hover:bg-accent"
      />

      {groups.map((g) => (
        <div key={g.label} className="flex flex-col items-center gap-0.5 side:items-stretch">
          <div className="hidden px-3 pt-2.5 pb-1 text-meta font-semibold text-muted-foreground side:block">
            {g.label}
          </div>
          {g.items.map((item) => {
            const active = isActive(item, pathname)
            const count = counts.of(item)
            const link = (
              <NavLink
                to={item.to}
                end={item.to === "/"}
                title={count ? `${item.label}: ${count.says}` : item.label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-[42px] w-12 items-center justify-center gap-2.5 rounded-sm text-ink transition-colors duration-150 side:h-8 side:w-full side:justify-start side:px-2.5",
                  "[@media(hover:hover)]:hover:bg-accent",
                  "aria-[current=page]:bg-primary aria-[current=page]:font-title aria-[current=page]:text-primary-foreground [@media(hover:hover)]:aria-[current=page]:hover:bg-primary",
                  "regular:aria-[current=page]:bg-fill regular:aria-[current=page]:font-semibold regular:aria-[current=page]:text-ink regular:[@media(hover:hover)]:aria-[current=page]:hover:bg-fill",
                )}
              >
                <item.icon
                  aria-hidden
                  className={cn("size-[18px] shrink-0", active ? "text-current" : "text-muted-foreground")}
                />
                <span className="hidden side:inline">{item.label}</span>
                {item.to === "/settings" && (
                  <ChevronRight aria-hidden className="ms-auto hidden size-3.5 opacity-60 side:block" />
                )}
                {count && (
                  <span
                    className={cn(
                      // Rail: an 8px dot; sidebar: the number in a tag.
                      "absolute end-2 top-[7px] size-2 rounded-full text-none side:static side:ms-auto side:size-auto side:rounded-tag side:px-[7px] side:py-px side:text-meta side:font-bold side:tabular-nums",
                      count.tone === "fail" ? "bg-fail" : "bg-warn",
                      // On the filled active item the number takes the item's colour instead of a tint;
                      // Regular's active item is a soft grey, so its number keeps the tint (#29).
                      active
                        ? "side:bg-transparent side:text-current"
                        : count.tone === "fail"
                          ? "side:tint-fail"
                          : "side:tint-warn",
                      active && (count.tone === "fail" ? "regular:side:tint-fail" : "regular:side:tint-warn"),
                      "regular:side:rounded-full",
                    )}
                  >
                    {n(count.value)}
                    <span className="sr-only"> {item.count === "problems" ? "open" : "waiting"}</span>
                  </span>
                )}
              </NavLink>
            )
            if (item.to === "/settings")
              return (
                <SectionsFlyout key={item.to} label={item.label}>
                  {link}
                </SectionsFlyout>
              )
            return (
              <Tooltip key={item.to}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right" className="side:hidden">
                  {item.label}
                  {count ? ` · ${count.says}` : ""}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      ))}

      <WorkersStatus
        workers={workers}
        className="mx-1 mt-3.5 hidden py-2 regular:side:mt-auto regular:side:flex [@media(hover:hover)]:hover:bg-accent"
      />
      <div className="mt-auto flex flex-col items-center gap-1 pt-3.5 side:flex-row side:px-1 regular:side:mt-0 regular:side:pt-1">
        <UserMenu />
        <ThemeButton />
      </div>
    </nav>
  )
}

/** How many workers are online, linking to the Workers page; drawn where each design wants it. */
function WorkersStatus({ workers, className }: { workers: Summary["workers"] | undefined; className?: string }) {
  const tone = !workers?.total ? "muted" : workers.online === workers.total ? "ok" : workers.online ? "warn" : "fail"
  return (
    <Link
      to="/workers"
      data-slot="workers-status"
      title={workers?.total ? `Workers: ${n(workers.online)} of ${n(workers.total)} online` : "No worker paired"}
      className={cn("items-center gap-2.5 rounded-sm px-3", className)}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          tone === "ok" && "bg-ok",
          tone === "warn" && "bg-warn",
          tone === "fail" && "bg-fail",
          tone === "muted" && "bg-muted-foreground/50",
        )}
      />
      <span className="min-w-0">
        <b className="block truncate text-ctl">Workers</b>
        <span className={cn("block text-meta text-muted-foreground", tone === "fail" && "text-fail")}>
          {workers?.total ? `${n(workers.online)} of ${n(workers.total)} online` : "none paired"}
        </span>
      </span>
    </Link>
  )
}

/** Cycles light, dark and the operating system; the choice is kept in this browser. */
function ThemeButton() {
  const { theme, setTheme } = useTheme()
  const order = ["system", "light", "dark"] as const
  const current = (theme as (typeof order)[number]) ?? "system"
  const next = order[(order.indexOf(current) + 1) % order.length] ?? "system"
  const Icon = current === "dark" ? Moon : current === "light" ? Sun : Monitor
  const label = `Theme: ${current === "system" ? "System" : current === "dark" ? "Dark" : "Light"}. Switch to ${next}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon" aria-label={label} onClick={() => setTheme(next)}>
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

function UserMenu({ compact }: { compact?: boolean }) {
  const navigate = useNavigate()
  const client = useQueryClient()
  const session = authClient.useSession()
  const { theme, setTheme } = useTheme()
  const name = (session.data?.user as { username?: string } | undefined)?.username ?? session.data?.user.name ?? ""
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className={cn(
            "flex min-w-0 items-center gap-2.5 rounded-sm p-1 text-start aria-expanded:bg-accent side:flex-1 [@media(hover:hover)]:hover:bg-accent",
            compact && "side:flex-none",
          )}
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-fill text-meta font-bold">
            {name.slice(0, 2).toUpperCase()}
          </span>
          {!compact && (
            <span className="hidden min-w-0 side:block">
              <span className="block truncate text-ctl font-semibold">{name}</span>
              <span className="block text-meta text-muted-foreground">Account</span>
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuLabel>
          <div className="font-semibold text-ink">{name}</div>
          <div className="flex items-center gap-1 text-meta font-normal text-muted-foreground">
            <ShieldCheck className="size-3" />
            Two-factor on
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">
            <Sun /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/account")}>
          <UserRound /> Account
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={async () => {
            await authClient.signOut()
            client.clear()
            navigate("/login", { replace: true })
          }}
        >
          <LogOut /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Phone: a slim top bar with the page name, a problems pill when there are any, and the account menu. */
function PhoneTopBar() {
  const { pathname } = useLocation()
  const counts = useCounts()
  const open = counts.summary?.openProblems ?? 0
  return (
    <header className="sticky top-0 z-30 flex h-topbar shrink-0 items-center gap-2.5 border-b border-line bg-bg/94 ps-3.5 pe-2 backdrop-blur-md md:hidden">
      <Link to="/" aria-label="n8n-ops, Overview" className="flex shrink-0 rounded-sm">
        <BrandMark className="size-7" />
      </Link>
      <div className="grid min-w-0 leading-[1.15]">
        <span className="truncate text-meta font-semibold text-muted-foreground">n8n-ops</span>
        <span className="truncate text-h2 font-bold">{pageOf(pathname)?.item.label ?? "n8n-ops"}</span>
      </div>
      {open > 0 && pathname !== "/problems" && (
        <Link
          to="/problems"
          className="tint-fail ms-auto flex h-8 shrink-0 items-center gap-[7px] rounded-full px-3 text-ctl font-semibold before:size-[7px] before:rounded-full before:bg-current"
        >
          {plural(open, "problem")}
        </Link>
      )}
      <div className={cn("flex shrink-0 items-center", !(open > 0 && pathname !== "/problems") && "ms-auto")}>
        <PhoneSearch pages={searchPages} />
        <UserMenu compact />
      </div>
    </header>
  )
}

/** Phone: the bottom tab bar. The fifth tab opens every page in a sheet above the bar; Back closes it. */
function TabBar() {
  const { pathname } = useLocation()
  const counts = useCounts()
  const [more, setMore] = useState(false)
  useOverlayHistory(more, () => setMore(false))
  // A page chosen in the sheet closes it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on every navigation
  useEffect(() => setMore(false), [pathname])
  const inMore = !tabs.some((t) => isActive(t, pathname))
  const pip = groups.flatMap((g) => g.items).some((i) => !tabs.includes(i) && counts.of(i))
  const tabClass =
    "relative flex flex-1 flex-col items-center justify-center gap-[3px] text-meta font-semibold text-muted-foreground aria-[current=page]:text-ink [&_svg]:size-[22px]"
  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 flex h-[calc(var(--spacing-tabbar)+env(safe-area-inset-bottom))] border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {tabs.map((t) => {
          const count = counts.of(t)
          return (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.to === "/"}
              aria-current={isActive(t, pathname) ? "page" : undefined}
              className={tabClass}
            >
              <t.icon aria-hidden />
              {t.label}
              {count && (
                <span
                  className={cn(
                    "absolute start-[calc(50%+6px)] top-[9px] size-2 rounded-full border-2 border-panel",
                    count.tone === "fail" ? "bg-fail" : "bg-warn",
                  )}
                >
                  <span className="sr-only">{count.says}</span>
                </span>
              )}
            </NavLink>
          )
        })}
        <button
          type="button"
          className={tabClass}
          aria-current={inMore ? "page" : undefined}
          aria-expanded={more}
          onClick={() => setMore((v) => !v)}
        >
          <Ellipsis aria-hidden />
          More
          {pip && (
            <span className="absolute start-[calc(50%+6px)] top-[9px] size-2 rounded-full border-2 border-panel bg-warn" />
          )}
        </button>
      </nav>
      <SheetPrimitive.Root open={more} onOpenChange={setMore}>
        <SheetPrimitive.Portal>
          <SheetPrimitive.Overlay className="fixed inset-x-0 top-0 bottom-[calc(var(--spacing-tabbar)+env(safe-area-inset-bottom))] z-35 bg-black/40 duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 md:hidden" />
          <SheetPrimitive.Content
            aria-describedby={undefined}
            // Focus the sheet itself, not its first link, so no tooltip pops up on open.
            onOpenAutoFocus={(e) => {
              e.preventDefault()
              ;(e.currentTarget as HTMLElement).focus()
            }}
            tabIndex={-1}
            className="fixed inset-x-0 bottom-[calc(var(--spacing-tabbar)+env(safe-area-inset-bottom))] z-36 flex max-h-[calc(100dvh-var(--spacing-tabbar)-60px-env(safe-area-inset-bottom))] flex-col gap-0.5 overflow-y-auto overscroll-contain rounded-t-drawer border-b border-line bg-bg px-3 pt-2 pb-3 duration-200 ease-out data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom-8 data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-8 md:hidden"
          >
            <SheetPrimitive.Title className="sr-only">All pages</SheetPrimitive.Title>
            <span aria-hidden className="mx-auto mt-1 mb-1.5 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/50" />
            {groups.map((g) => (
              <div key={g.label} className="flex flex-col gap-0.5">
                <div className="px-3 pt-2.5 pb-1 text-meta font-semibold text-muted-foreground">{g.label}</div>
                {g.items.map((item) => {
                  const count = counts.of(item)
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === "/"}
                      // Replaces the sheet's Back entry, so Back afterwards leaves the new page in one step.
                      replace
                      aria-current={isActive(item, pathname) ? "page" : undefined}
                      className="flex min-h-touch items-center gap-2.5 rounded-sm px-2.5 aria-[current=page]:bg-primary aria-[current=page]:font-title aria-[current=page]:text-primary-foreground regular:aria-[current=page]:bg-fill regular:aria-[current=page]:font-semibold regular:aria-[current=page]:text-ink"
                    >
                      <item.icon aria-hidden className="size-[18px] shrink-0" />
                      {item.label}
                      {count && (
                        <span
                          title={count.says}
                          className={cn(
                            "ms-auto rounded-tag px-[7px] py-px text-meta font-bold tabular-nums",
                            isActive(item, pathname)
                              ? "bg-transparent text-current"
                              : count.tone === "fail"
                                ? "tint-fail"
                                : "tint-warn",
                          )}
                        >
                          {n(count.value)}
                        </span>
                      )}
                    </NavLink>
                  )
                })}
              </div>
            ))}
            <div className="mt-2 flex items-center gap-1 border-t border-line pt-2">
              <ThemeButton />
            </div>
          </SheetPrimitive.Content>
        </SheetPrimitive.Portal>
      </SheetPrimitive.Root>
    </>
  )
}

/** Back and Forward return to where the page was scrolled; a new page starts at its top (NL-3). An item opened
 * on the same page leaves the list where it is. */
function useScrollMemory(main: HTMLElement | null) {
  const location = useLocation()
  const type = useNavigationType()
  const saved = useRef(new Map<string, number>())
  const lastPage = useRef(location.pathname.split("/")[1])
  useEffect(() => {
    if (!main) return
    const remember = () => saved.current.set(location.key, main.scrollTop)
    main.addEventListener("scroll", remember, { passive: true })
    return () => main.removeEventListener("scroll", remember)
  }, [main, location.key])
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per history entry
  useLayoutEffect(() => {
    if (!main) return
    const page = location.pathname.split("/")[1]
    const newPage = page !== lastPage.current
    lastPage.current = page
    if (type === "POP") main.scrollTop = saved.current.get(location.key) ?? main.scrollTop
    // Opening an item of the same page keeps the list where it was behind it.
    else if (type === "PUSH" && newPage) main.scrollTop = 0
  }, [main, location.key])
}

/**
 * A phone keyboard can leave the window panned after it closes, hiding the top bar. The frame never scrolls,
 * so any window scroll is undone, except while a field is being edited (MO-1).
 */
function useWindowPanReset() {
  useEffect(() => {
    const editing = () => document.activeElement?.matches("input, textarea, select, [contenteditable]") ?? false
    const reset = () => {
      if (!editing() && (window.scrollX || window.scrollY)) window.scrollTo(0, 0)
    }
    const later = (ms: number) => () => setTimeout(reset, ms)
    const onBlur = later(300)
    const onResize = later(100)
    window.addEventListener("scroll", reset, { passive: true })
    window.addEventListener("focusout", onBlur)
    window.visualViewport?.addEventListener("resize", onResize)
    return () => {
      window.removeEventListener("scroll", reset)
      window.removeEventListener("focusout", onBlur)
      window.visualViewport?.removeEventListener("resize", onResize)
    }
  }, [])
}

/**
 * Signed-in layout. The browser never scrolls: the frame is the screen's height and the page scrolls inside
 * <main>. From 761px a top bar runs across; above 1100px a sidebar that can fold into the icon rail, down to
 * 761px the icon rail, below that a phone top bar and a tab bar.
 */
export function AppShell() {
  useLiveUpdates()
  useWindowPanReset()
  const nav = useNavFolded()
  const { pathname } = useLocation()
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null)
  const [main, setMain] = useState<HTMLElement | null>(null)
  const [crumbs, setCrumbs] = useState<[number, string][]>([])
  const setCrumb = useCallback((id: number, label: string | null) => {
    setCrumbs((prev) => {
      const rest = prev.filter(([i]) => i !== id)
      return label ? [...rest, [id, label]] : rest.length === prev.length ? prev : rest
    })
  }, [])
  const crumb = crumbs.at(-1)?.[1] ?? null
  useScrollMemory(main)

  // The browser tab names the opened item and the page (NL-3).
  const page = pageOf(pathname)?.item.label
  useEffect(() => {
    document.title = [crumb, page, "n8n-ops"].filter(Boolean).join(" · ")
  }, [crumb, page])

  return (
    <ChromeContext.Provider value={{ actionsSlot, setCrumb }}>
      <DesignSync />
      {/*
       * Two columns from 761px: the brand and the sidebar, then the bar and the page. Compact splits them with
       * lines; Regular sets the sidebar on a grey canvas and the bar and page in one floating card (#29). The
       * card is drawn behind them, so the order of the page for the keyboard and screen readers stays as is.
       */}
      <div className="grid h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-bg transition-[grid-template-columns] duration-200 md:grid-cols-[var(--spacing-rail)_minmax(0,1fr)] side:grid-cols-[var(--spacing-side)_minmax(0,1fr)] regular:md:bg-canvas">
        <div
          aria-hidden
          data-slot="page-frame"
          className="pointer-events-none hidden rounded-lg bg-bg shadow-card ring-1 ring-ink/10 md:col-start-2 md:row-span-2 md:row-start-1 md:m-2 md:ms-0 regular:md:block"
        />
        <TopBar crumb={crumb} nav={nav} setActionsSlot={setActionsSlot} />
        <PhoneTopBar />
        <SideNav nav={nav} />
        <main
          ref={setMain}
          id="main"
          className="relative col-start-1 row-start-2 min-h-0 overflow-y-auto overscroll-contain px-3 pt-4 pb-[calc(var(--spacing-tabbar)+16px+env(safe-area-inset-bottom))] md:col-start-2 md:p-[22px] md:pb-15 lg:px-7 regular:md:me-2 regular:md:mb-2 regular:md:rounded-b-lg"
        >
          <SaveScope>
            <Outlet />
          </SaveScope>
        </main>
        <TabBar />
      </div>
    </ChromeContext.Provider>
  )
}

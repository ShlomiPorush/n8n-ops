import { useQueryClient } from "@tanstack/react-query"
import {
  Bug,
  Cpu,
  DatabaseBackup,
  Ellipsis,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Monitor,
  Moon,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  Sun,
  Workflow,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Dialog as SheetPrimitive } from "radix-ui"
import { useEffect, useState } from "react"
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router"
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
import { ApiError, useApi } from "@/lib/api"
import { authClient } from "@/lib/auth-client"
import { useLiveUpdates } from "@/lib/live"
import { n } from "@/lib/time"
import { cn } from "@/lib/utils"

type NavItem = { to: string; label: string; icon: typeof Bug; count?: "problems" | "access" }
const operate: NavItem[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/problems", label: "Problems", icon: Bug, count: "problems" },
  { to: "/instances", label: "Instances", icon: Server },
  { to: "/workflows", label: "Workflows", icon: Workflow },
  { to: "/backups", label: "Backups", icon: DatabaseBackup },
  { to: "/access", label: "Agent access", icon: KeyRound, count: "access" },
]
const system: NavItem[] = [
  { to: "/workers", label: "Workers", icon: Cpu },
  { to: "/settings", label: "Settings", icon: Settings },
  { to: "/audit", label: "Audit log", icon: ScrollText },
]
const groups = [
  { label: "Operate", items: operate },
  { label: "System", items: system },
]
/** The phone tab bar: the four pages used most; every page is in the More sheet. */
const tabs = operate.slice(0, 4)

const titles: Record<string, string> = Object.fromEntries([...operate, ...system].map((i) => [i.to, i.label]))

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

const isActive = (item: NavItem, pathname: string) =>
  item.to === "/" ? pathname === "/" : pathname === item.to || pathname.startsWith(`${item.to}/`)

/** How many things on this page wait for action, and how urgent they are. Nothing when there is nothing to do. */
function useCounts() {
  const summary = useApi<Summary>("/overview/summary", { refetchInterval: 30_000 })
  const s = summary.data
  return {
    summary: s,
    of(item: NavItem): { value: number; tone: "fail" | "warn" } | null {
      if (item.count === "problems" && s?.openProblems) return { value: s.openProblems, tone: "fail" }
      if (item.count === "access" && s?.pendingAccess) return { value: s.pendingAccess, tone: "warn" }
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

function SideNav() {
  const { pathname } = useLocation()
  const counts = useCounts()
  const workers = counts.summary?.workers
  const workerTone = !workers?.total
    ? "muted"
    : workers.online === workers.total
      ? "ok"
      : workers.online
        ? "warn"
        : "fail"
  return (
    <nav
      aria-label="Main"
      className="hidden h-dvh w-rail shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-e border-line bg-bg px-2.5 py-3.5 md:flex lg:w-side lg:items-stretch"
    >
      <Link
        to="/"
        className="mb-3 flex items-center gap-2.5 rounded-sm px-0 pt-1 lg:px-2.5"
        aria-label="n8n-ops, Overview"
      >
        <BrandMark />
        <span className="hidden min-w-0 lg:block">
          <span className="block truncate text-head font-bold tracking-tight">n8n-ops</span>
          <span className="block truncate text-meta text-muted-foreground">Operations console</span>
        </span>
      </Link>

      <Link
        to="/workers"
        className="mx-1 mb-3 hidden items-center gap-2.5 rounded-sm bg-panel px-3 py-2.5 hover:bg-accent lg:flex"
      >
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            workerTone === "ok" && "bg-ok",
            workerTone === "warn" && "bg-warn",
            workerTone === "fail" && "bg-fail",
            workerTone === "muted" && "bg-muted-foreground/50",
          )}
        />
        <span className="min-w-0">
          <b className="block truncate text-ctl">Workers</b>
          <span className={cn("block text-meta text-muted-foreground", workerTone === "fail" && "text-fail")}>
            {workers?.total ? `${n(workers.online)} of ${n(workers.total)} online` : "none paired"}
          </span>
        </span>
      </Link>

      {groups.map((g) => (
        <div key={g.label} className="flex flex-col items-center gap-0.5 lg:items-stretch">
          <div className="hidden px-3 pt-2.5 pb-1 text-meta font-semibold text-muted-foreground lg:block">
            {g.label}
          </div>
          {g.items.map((item) => {
            const active = isActive(item, pathname)
            const count = counts.of(item)
            return (
              <Tooltip key={item.to}>
                <TooltipTrigger asChild>
                  <NavLink
                    to={item.to}
                    end={item.to === "/"}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex h-[42px] w-12 items-center justify-center gap-2.5 rounded-sm text-ink transition-colors duration-150 lg:h-8 lg:w-full lg:justify-start lg:px-2.5",
                      "[@media(hover:hover)]:hover:bg-accent",
                      "aria-[current=page]:bg-primary aria-[current=page]:font-title aria-[current=page]:text-primary-foreground [@media(hover:hover)]:aria-[current=page]:hover:bg-primary",
                    )}
                  >
                    <item.icon
                      aria-hidden
                      className={cn("size-[18px] shrink-0", active ? "text-current" : "text-muted-foreground")}
                    />
                    <span className="hidden lg:inline">{item.label}</span>
                    {count && (
                      <span
                        className={cn(
                          // Rail: an 8px dot; sidebar: the number in a tag.
                          "absolute end-2 top-[7px] size-2 rounded-full text-[0px] lg:static lg:ms-auto lg:size-auto lg:rounded-tag lg:px-[7px] lg:py-px lg:text-meta lg:font-bold lg:tabular-nums",
                          count.tone === "fail" ? "bg-fail" : "bg-warn",
                          // On the filled active item the number takes the item's colour instead of a tint.
                          active
                            ? "lg:bg-transparent lg:text-current"
                            : count.tone === "fail"
                              ? "lg:tint-fail"
                              : "lg:tint-warn",
                        )}
                      >
                        {n(count.value)}
                        <span className="sr-only"> {item.count === "problems" ? "open" : "waiting"}</span>
                      </span>
                    )}
                  </NavLink>
                </TooltipTrigger>
                <TooltipContent side="right" className="lg:hidden">
                  {item.label}
                  {count ? ` · ${n(count.value)}` : ""}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      ))}

      <div className="mt-auto flex flex-col items-center gap-1 pt-3.5 lg:flex-row lg:px-1">
        <UserMenu />
        <ThemeButton />
      </div>
    </nav>
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
            "flex min-w-0 items-center gap-2.5 rounded-sm p-1 text-start hover:bg-accent aria-expanded:bg-accent lg:flex-1",
            compact && "lg:flex-none",
          )}
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-panel text-meta font-bold">
            {name.slice(0, 2).toUpperCase()}
          </span>
          {!compact && (
            <span className="hidden min-w-0 lg:block">
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
        <DropdownMenuItem onClick={() => navigate("/settings/account")}>
          <Settings /> Account settings
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
function TopBar() {
  const { pathname } = useLocation()
  const counts = useCounts()
  const base = `/${pathname.split("/")[1] ?? ""}`
  const open = counts.summary?.openProblems ?? 0
  return (
    <header className="sticky top-0 z-30 flex h-topbar shrink-0 items-center gap-2.5 border-b border-line bg-bg/94 ps-3.5 pe-2 backdrop-blur-md md:hidden">
      <Link to="/" aria-label="n8n-ops, Overview" className="flex shrink-0 rounded-sm">
        <BrandMark className="size-7" />
      </Link>
      <div className="grid min-w-0 leading-[1.15]">
        <span className="truncate text-meta font-semibold text-muted-foreground">n8n-ops</span>
        <span className="truncate text-h2 font-bold">{titles[base] ?? "n8n-ops"}</span>
      </div>
      {open > 0 && pathname !== "/problems" && (
        <Link
          to="/problems"
          className="tint-fail ms-auto flex h-8 shrink-0 items-center gap-[7px] rounded-full px-3 text-ctl font-semibold before:size-[7px] before:rounded-full before:bg-current"
        >
          {n(open)} {open === 1 ? "problem" : "problems"}
        </Link>
      )}
      <div className={cn("flex shrink-0", !(open > 0 && pathname !== "/problems") && "ms-auto")}>
        <UserMenu compact />
      </div>
    </header>
  )
}

/** Phone: the bottom tab bar. The fifth tab opens every page in a sheet above the bar. */
function TabBar() {
  const { pathname } = useLocation()
  const counts = useCounts()
  const [more, setMore] = useState(false)
  // A page chosen in the sheet closes it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on every navigation
  useEffect(() => setMore(false), [pathname])
  const inMore = !tabs.some((t) => isActive(t, pathname))
  const pip = [...operate, ...system].some((i) => !tabs.includes(i) && counts.of(i))
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
                    "absolute top-[9px] left-[calc(50%+6px)] size-2 rounded-full border-2 border-panel",
                    count.tone === "fail" ? "bg-fail" : "bg-warn",
                  )}
                >
                  <span className="sr-only">
                    {n(count.value)} {t.count === "problems" ? "open" : "waiting"}
                  </span>
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
            <span className="absolute top-[9px] left-[calc(50%+6px)] size-2 rounded-full border-2 border-panel bg-warn" />
          )}
        </button>
      </nav>
      <SheetPrimitive.Root open={more} onOpenChange={setMore}>
        <SheetPrimitive.Portal>
          <SheetPrimitive.Overlay className="fixed inset-x-0 top-0 bottom-[calc(var(--spacing-tabbar)+env(safe-area-inset-bottom))] z-35 bg-black/40 duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 md:hidden" />
          <SheetPrimitive.Content
            aria-describedby={undefined}
            // Focus the sheet itself, not its first button, so no tooltip pops up on open.
            onOpenAutoFocus={(e) => {
              e.preventDefault()
              ;(e.currentTarget as HTMLElement).focus()
            }}
            tabIndex={-1}
            className="fixed inset-x-0 bottom-[calc(var(--spacing-tabbar)+env(safe-area-inset-bottom))] z-36 flex max-h-[calc(100dvh-var(--spacing-tabbar)-60px-env(safe-area-inset-bottom))] flex-col gap-0.5 overflow-y-auto rounded-t-sheet border-b border-line bg-bg px-3 pt-2 pb-3 duration-200 ease-out data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom-8 data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-8 md:hidden"
          >
            <SheetPrimitive.Title className="sr-only">All pages</SheetPrimitive.Title>
            <span aria-hidden className="mx-auto mt-1 mb-1.5 h-1 w-10 rounded-full bg-muted-foreground/50" />
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
                      aria-current={isActive(item, pathname) ? "page" : undefined}
                      className="flex min-h-touch items-center gap-2.5 rounded-sm px-2.5 aria-[current=page]:bg-primary aria-[current=page]:font-title aria-[current=page]:text-primary-foreground"
                    >
                      <item.icon aria-hidden className="size-[18px] shrink-0" />
                      {item.label}
                      {count && (
                        <span
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

/**
 * Signed-in layout. The browser never scrolls: the frame is the screen's height and the page scrolls
 * inside <main>. Above 1100px a sidebar, down to 761px an icon rail, below that a top bar and a tab bar.
 */
export function AppShell() {
  useLiveUpdates()
  return (
    <div className="flex h-dvh overflow-hidden bg-bg">
      <SideNav />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main
          id="main"
          className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-4 pb-[calc(var(--spacing-tabbar)+16px+env(safe-area-inset-bottom))] md:p-[22px] md:pb-15 lg:px-7"
        >
          <SaveScope>
            <Outlet />
          </SaveScope>
        </main>
        <TabBar />
      </div>
    </div>
  )
}

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
import { cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate, useNavigationType } from "react-router"
import { AttentionBell } from "@/app/attention-bell"
import { ChromeContext } from "@/app/chrome"
import { DesignSync } from "@/app/design-sync"
import { groups, isActive, type NavItem, operate, pageGroups, pageOf } from "@/app/nav"
import { GlobalSearch, PhoneSearch, type SearchPage } from "@/app/search"
import { SessionGuard } from "@/app/session-guard"
import { settingsGroups } from "@/app/settings-sections"
import { BrandMark } from "@/components/brand-mark"
import { SaveScope, useConfirmLeave } from "@/components/save-bar"
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
import { useIsMobile, useMediaQuery } from "@/hooks/use-mobile"
import { ApiError, useApi } from "@/lib/api"
import { authClient } from "@/lib/auth-client"
import { SCROLL_RESTORE_MS } from "@/lib/behavior"
import { useLiveUpdates } from "@/lib/live"
import { n, plural } from "@/lib/numbers"
import { useNavigateFromOverlay, useOverlayHistory } from "@/lib/overlay-history"
import { type Area, placeSpot, readSpot, type ScrollSpot, shownEntry } from "@/lib/scroll-spot"
import { heldBy } from "@/lib/scroller"
import { loginPath, sessionClosed, sessionStarted } from "@/lib/session"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"

const tabs = operate.slice(0, 4)
const searchPages: SearchPage[] = pageGroups.flatMap((g) =>
  g.items.map((i) => ({ to: i.to, label: i.label, group: g.label })),
)

type Summary = {
  openProblems: number
  pendingAccess: number
  workers: { online: number; total: number }
  version: string
}
type Me = { twoFactor: boolean }

export function RequireAuth() {
  const me = useApi<Me>("/setup/checklist")
  const { pathname, search } = useLocation()
  useEffect(() => {
    if (me.data) sessionStarted()
  }, [me.data])
  if (me.isLoading) return null
  if (me.error instanceof ApiError && me.error.status === 401)
    return <Navigate to={loginPath(pathname, search, me.error.reason)} replace />
  if (me.data && !me.data.twoFactor) return <Navigate to="/setup" replace />
  return (
    <>
      {me.data && <SessionGuard />}
      <Outlet />
    </>
  )
}

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
      } catch {}
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

function TopBar({
  trail,
  nav,
  setActionsSlot,
}: {
  trail: string[]
  nav: ReturnType<typeof useNavFolded>
  setActionsSlot: (el: HTMLDivElement | null) => void
}) {
  const { pathname } = useLocation()
  const page = pageOf(pathname)
  const atRoot = page && (pathname === page.item.to || pathname === `${page.item.to}/`)
  const [searching, setSearching] = useState(false)
  return (
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
              <h1 className="truncate text-bar font-heavy regular:text-body regular:font-medium regular:tracking-tighter regular:tracking-normal">
                {page && !atRoot && trail.length > 0 ? (
                  <Link to={page.item.to} className="underline-offset-3 [@media(hover:hover)]:hover:underline">
                    {page.item.label}
                  </Link>
                ) : (
                  <span aria-current={trail.length > 0 ? undefined : "page"}>{page?.item.label ?? "n8n-ops"}</span>
                )}
              </h1>
            </li>
            {trail.map((crumb, i) => {
              const last = i === trail.length - 1
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: a crumb's place is its level in the trail
                <li key={i} className={cn("flex min-w-0 items-center gap-2", last ? "shrink" : "shrink-[2]")}>
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span
                    aria-current={last ? "page" : undefined}
                    className={cn("truncate text-body", last && "font-semibold")}
                    dir="auto"
                  >
                    <bdi>{crumb}</bdi>
                  </span>
                </li>
              )
            })}
          </ol>
        </nav>
        <GlobalSearch pages={searchPages} variant="bar" onOpenChange={setSearching} />
        <div
          ref={setActionsSlot}
          className={cn("ms-3 flex shrink-0 items-center gap-2 empty:hidden", searching && "hidden")}
        />
        <div className="ms-2.5 me-[22px] flex shrink-0 items-center lg:me-7">
          <AttentionBell />
        </div>
      </div>
    </header>
  )
}

function SectionsFlyout({ children, label }: { children: React.ReactElement<React.AriaAttributes>; label: string }) {
  const [open, setOpen] = useState(false)
  const byKey = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const pointer = useMediaQuery("(hover: hover)")
  const { pathname } = useLocation()
  // biome-ignore lint/correctness/useExhaustiveDependencies: a chosen section closes the menu
  useEffect(() => setOpen(false), [pathname])
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener("resize", close)
    return () => window.removeEventListener("resize", close)
  }, [open])
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
          {cloneElement(children, { "aria-haspopup": "menu", "aria-expanded": open })}
        </div>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          role="menu"
          aria-label={`${label} sections`}
          onPointerEnter={show}
          onPointerLeave={hide}
          onOpenAutoFocus={(e) => {
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
          <b aria-hidden className="px-2.5 pt-1 pb-0.5 text-small text-muted-foreground">
            {label}
          </b>
          {settingsGroups.flatMap((g) =>
            g.items.map(([key, name]) => (
              <NavLink
                key={key}
                role="menuitem"
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
      <NavToggle {...nav} className="mb-2 hidden compact:folded:inline-flex" />

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
                to={item.to === "/settings" && pathname.startsWith("/settings/") ? pathname : item.to}
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
                      "absolute end-2 top-[7px] size-2 rounded-full text-none side:static side:ms-auto side:size-auto side:rounded-tag side:px-[7px] side:py-px side:text-meta side:font-bold side:tabular-nums",
                      count.tone === "fail" ? "bg-fail" : "bg-warn",
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
      {counts.summary?.version && (
        <p data-testid="app-version" className="hidden px-3 pt-2 text-meta text-muted-foreground side:block">
          n8n-ops {counts.summary.version}
        </p>
      )}
    </nav>
  )
}

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
  const confirmLeave = useConfirmLeave()
  const session = authClient.useSession()
  const { theme, setTheme } = useTheme()
  const name = (session.data?.user as { username?: string } | undefined)?.username ?? session.data?.user.name ?? ""
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={[name, "Account menu"].filter(Boolean).join(" ")}
          className={cn(
            "flex min-w-0 items-center gap-2.5 rounded-sm p-1 text-start aria-expanded:bg-accent side:flex-1 [@media(hover:hover)]:hover:bg-accent",
            compact && "side:flex-none",
          )}
        >
          <span
            aria-hidden
            data-initials={name.slice(0, 2).toUpperCase()}
            className="grid size-7 shrink-0 place-items-center rounded-full bg-fill text-meta font-bold before:content-[attr(data-initials)]"
          />
          {!compact && (
            <span className="hidden min-w-0 side:block">
              <span className="block truncate text-ctl font-semibold">{name}</span>{" "}
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
            if (!(await confirmLeave())) return
            const { error } = await authClient.signOut().catch((e: unknown) => ({ error: e }))
            if (error) {
              toast.error("Could not sign out. Try again in a moment.")
              return
            }
            sessionClosed()
            client.clear()
            navigate("/login", { replace: true })
          }}
        >
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PhoneTopBar() {
  const { pathname } = useLocation()
  return (
    <header
      data-slot="phone-top-bar"
      className="sticky top-0 z-30 flex h-topbar shrink-0 items-center gap-2.5 border-b border-line bg-bg/94 ps-3.5 pe-2 backdrop-blur-md md:hidden"
    >
      <Link to="/" aria-label="n8n-ops, Overview" className="flex shrink-0 rounded-sm">
        <BrandMark className="size-7" />
      </Link>
      <div className="grid min-w-0 leading-[1.15]">
        <span className="truncate text-meta font-semibold text-muted-foreground">n8n-ops</span>
        <span className="truncate text-h2 font-bold">{pageOf(pathname)?.item.label ?? "n8n-ops"}</span>
      </div>
      <div className="ms-auto flex shrink-0 items-center">
        <AttentionBell phone />
        <PhoneSearch pages={searchPages} />
        <UserMenu compact />
      </div>
    </header>
  )
}

function TabBar() {
  const { pathname } = useLocation()
  const counts = useCounts()
  const [more, setMore] = useState(false)
  useOverlayHistory(more, () => setMore(false))
  const navigateFromSheet = useNavigateFromOverlay()
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on every navigation
  useEffect(() => setMore(false), [pathname])
  const phone = useIsMobile()
  useEffect(() => {
    if (!phone) setMore(false)
  }, [phone])
  const openFromSheet = (to: string, e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!more || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false
    e.preventDefault()
    if (to === pathname) setMore(false)
    else navigateFromSheet(to)
    return true
  }
  useEffect(() => {
    if (!more) return
    const behind = [document.getElementById("main"), document.querySelector('[data-slot="phone-top-bar"]')].filter(
      (el): el is HTMLElement => el !== null && !el.hasAttribute("inert"),
    )
    for (const el of behind) el.setAttribute("inert", "")
    return () => {
      for (const el of behind) el.removeAttribute("inert")
    }
  }, [more])
  const inMore = !tabs.some((t) => isActive(t, pathname))
  const held = groups
    .flatMap((g) => g.items)
    .filter((i) => !tabs.includes(i))
    .flatMap((i) => {
      const count = counts.of(i)
      return count ? [{ ...count, label: i.label }] : []
    })
  const pipTone = held.some((c) => c.tone === "fail") ? "fail" : held.length ? "warn" : null
  const tabClass =
    "relative flex flex-1 flex-col items-center justify-center gap-[3px] text-meta font-semibold text-muted-foreground aria-[current=page]:text-ink [&_svg]:size-[22px]"
  return (
    <SheetPrimitive.Root open={more} onOpenChange={setMore} modal={false}>
      <nav
        aria-label="Main"
        data-slot="tab-bar"
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
              onClick={(e) => {
                openFromSheet(t.to, e)
              }}
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
        <SheetPrimitive.Trigger asChild>
          <button type="button" className={tabClass} aria-current={inMore ? "page" : undefined}>
            <Ellipsis aria-hidden />
            More
            {pipTone && (
              <span
                className={cn(
                  "absolute start-[calc(50%+6px)] top-[9px] size-2 rounded-full border-2 border-panel",
                  pipTone === "fail" ? "bg-fail" : "bg-warn",
                )}
              >
                <span className="sr-only">{held.map((c) => `${c.label}: ${c.says}`).join(", ")}</span>
              </span>
            )}
          </button>
        </SheetPrimitive.Trigger>
      </nav>
      <div
        aria-hidden
        data-state={more ? "open" : "closed"}
        onClick={() => setMore(false)}
        className="invisible fixed inset-x-0 top-0 bottom-[calc(var(--spacing-tabbar)+env(safe-area-inset-bottom))] z-35 bg-black/40 opacity-0 transition-[opacity,visibility] duration-200 data-[state=open]:visible data-[state=open]:opacity-100 md:hidden"
      />
      <SheetPrimitive.Portal>
        <SheetPrimitive.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            ;(e.currentTarget as HTMLElement).focus()
          }}
          onInteractOutside={(e) => {
            if (
              e.target instanceof Element &&
              e.target.closest('[data-slot="tab-bar"], [data-toast], [role="alertdialog"]')
            )
              e.preventDefault()
          }}
          tabIndex={-1}
          className="fixed inset-x-0 bottom-[calc(var(--spacing-tabbar)+env(safe-area-inset-bottom))] z-36 flex max-h-[calc(100dvh-var(--spacing-tabbar)-60px-env(safe-area-inset-bottom))] flex-col gap-0.5 overflow-y-auto overscroll-contain rounded-t-drawer border-b border-line bg-bg px-3 pt-2 pb-3 duration-200 ease-out data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom-8 data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-8 md:hidden"
        >
          <SheetPrimitive.Title className="sr-only">All Pages</SheetPrimitive.Title>
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
                    onClick={(e) => openFromSheet(item.to, e)}
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
  )
}

const scrollPage = (pathname: string) => {
  const [, first, second] = pathname.split("/")
  return first === "settings" ? `settings/${second ?? ""}` : first
}

function scrollAreas(main: HTMLElement) {
  const areas = new Map<string, Area>([["page", main]])
  for (const el of document.querySelectorAll<HTMLElement>("[data-scroll-pane]")) {
    const name = el.dataset.scrollPane
    if (!name || areas.has(name)) continue
    const held = heldBy(el)
    areas.set(name, held ? { scrollTop: el.scrollTop, heldBy: held } : el)
  }
  return areas
}

function restoreScroll(main: HTMLElement, spot: ScrollSpot, done: (there: boolean) => void): () => void {
  const until = performance.now() + SCROLL_RESTORE_MS
  const user = ["wheel", "touchstart", "pointerdown", "keydown"] as const
  let frame = 0
  let stopped = false
  const stop = (there = false) => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(frame)
    for (const type of user) window.removeEventListener(type, onUser, true)
    done(there)
  }
  const onUser = () => stop()
  const apply = () => {
    const there = placeSpot(scrollAreas(main), spot)
    if (there || performance.now() > until) stop(there)
    else frame = requestAnimationFrame(apply)
  }
  for (const type of user) window.addEventListener(type, onUser, { capture: true, passive: true })
  apply()
  return onUser
}

function useScrollMemory(main: HTMLElement | null) {
  const location = useLocation()
  const type = useNavigationType()
  const saved = useRef(new Map<string, ScrollSpot>())
  const lastPage = useRef(scrollPage(location.pathname))
  const entry = useRef(location.key)
  const restoring = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!main) return
    const remember = (e: Event) => {
      if (restoring.current) return
      if (e.target !== main && !(e.target instanceof HTMLElement && e.target.matches("[data-scroll-pane]"))) return
      if (shownEntry(window.history.state) !== entry.current) return
      saved.current.set(entry.current, readSpot(scrollAreas(main)))
    }
    document.addEventListener("scroll", remember, { capture: true, passive: true })
    return () => document.removeEventListener("scroll", remember, { capture: true })
  }, [main])
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per history entry
  useLayoutEffect(() => {
    if (!main) return
    entry.current = location.key
    restoring.current?.()
    const page = scrollPage(location.pathname)
    const newPage = page !== lastPage.current
    lastPage.current = page
    const spot = type === "POP" ? saved.current.get(location.key) : undefined
    if (spot) {
      const key = location.key
      let finished = false
      const stop = restoreScroll(main, spot, (there) => {
        finished = true
        restoring.current = null
        if (there && entry.current === key) saved.current.set(key, readSpot(scrollAreas(main)))
      })
      if (!finished) restoring.current = stop
      return
    }
    if (type === "PUSH" && newPage) main.scrollTop = 0
    saved.current.set(location.key, readSpot(scrollAreas(main)))
  }, [main, location.key])
}

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
      if (!label) return rest.length === prev.length ? prev : rest
      return [...rest, [id, label] as [number, string]].sort((a, b) => a[0] - b[0])
    })
  }, [])
  const trail = crumbs.map(([, label]) => label)
  useScrollMemory(main)

  const page = pageOf(pathname)?.item.label
  const title = [...trail]
    .reverse()
    .concat(page ?? [], "n8n-ops")
    .join(" · ")
  useEffect(() => {
    document.title = title
  }, [title])

  return (
    <ChromeContext.Provider value={{ actionsSlot, setCrumb }}>
      <DesignSync />
      <SaveScope>
        <div className="grid h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-bg transition-[grid-template-columns] duration-200 md:grid-cols-[var(--spacing-rail)_minmax(0,1fr)] side:grid-cols-[var(--spacing-side)_minmax(0,1fr)] regular:md:bg-canvas">
          <div
            aria-hidden
            data-slot="page-frame"
            className="pointer-events-none hidden rounded-lg bg-bg shadow-card ring-1 ring-ink/10 md:col-start-2 md:row-span-2 md:row-start-1 md:m-2 md:ms-0 regular:md:block"
          />
          <TopBar trail={trail} nav={nav} setActionsSlot={setActionsSlot} />
          <PhoneTopBar />
          <SideNav nav={nav} />
          <main
            ref={setMain}
            id="main"
            className="relative col-start-1 row-start-2 min-h-0 overflow-y-auto overscroll-contain px-3 pt-(--main-pad-top) pb-[calc(var(--spacing-tabbar)+16px+env(safe-area-inset-bottom))] md:col-start-2 md:px-[22px] md:pb-15 lg:px-7 regular:md:me-2 regular:md:mb-2 regular:md:rounded-b-lg"
          >
            <Outlet />
          </main>
          <TabBar />
        </div>
      </SaveScope>
    </ChromeContext.Provider>
  )
}

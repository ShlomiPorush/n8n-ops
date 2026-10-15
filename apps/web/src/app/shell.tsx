import { useQueryClient } from "@tanstack/react-query"
import {
  Bug,
  Cpu,
  DatabaseBackup,
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
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from "@/components/ui/breadcrumb"
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
import { Separator } from "@/components/ui/separator"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { ApiError, useApi } from "@/lib/api"
import { authClient } from "@/lib/auth-client"
import { useLiveUpdates } from "@/lib/live"
import { cn } from "@/lib/utils"

type NavItem = { to: string; label: string; icon: typeof Bug; badge?: "problems" | "access" }
const operate: NavItem[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/problems", label: "Problems", icon: Bug, badge: "problems" },
  { to: "/instances", label: "Instances", icon: Server },
  { to: "/workflows", label: "Workflows", icon: Workflow },
  { to: "/backups", label: "Backups", icon: DatabaseBackup },
  { to: "/access", label: "Agent access", icon: KeyRound, badge: "access" },
]
const system: NavItem[] = [
  { to: "/workers", label: "Workers", icon: Cpu },
  { to: "/settings", label: "Settings", icon: Settings },
  { to: "/audit", label: "Audit log", icon: ScrollText },
]
const titles: Record<string, string> = Object.fromEntries([...operate, ...system].map((i) => [i.to, i.label]))

type Summary = { openProblems: number; pendingAccess: number; workers: { online: number; total: number } }
type Me = { twoFactor: boolean }

/** Signed-in area: redirects to login or to two-factor setup when needed. */
export function RequireAuth() {
  const me = useApi<Me>("/setup/checklist")
  if (me.isLoading) return null
  if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/login" replace />
  if (me.data && !me.data.twoFactor) return <Navigate to="/setup" replace />
  return <Outlet />
}

function AppSidebar() {
  const summary = useApi<Summary>("/overview/summary", { refetchInterval: 30_000 })
  const { pathname } = useLocation()
  // The button must be the link itself (asChild): the badge is positioned as a sibling of the button.
  const renderItem = (item: NavItem) => (
    <SidebarMenuItem key={item.to}>
      <SidebarMenuButton
        asChild
        isActive={item.to === "/" ? pathname === "/" : pathname.startsWith(item.to)}
        tooltip={item.label}
      >
        <NavLink to={item.to} end={item.to === "/"}>
          <item.icon />
          <span>{item.label}</span>
        </NavLink>
      </SidebarMenuButton>
      {item.badge === "problems" && (summary.data?.openProblems ?? 0) > 0 && (
        <SidebarMenuBadge>{summary.data?.openProblems}</SidebarMenuBadge>
      )}
      {item.badge === "access" && (summary.data?.pendingAccess ?? 0) > 0 && (
        <SidebarMenuBadge className="text-amber-700 dark:text-amber-400">
          {summary.data?.pendingAccess}
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  )
  const workers = summary.data?.workers
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <NavLink to="/">
              <SidebarMenuButton size="lg">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary font-bold text-sidebar-primary-foreground">
                  n
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">n8n-ops</span>
                  <span className="truncate text-xs text-muted-foreground">Operations console</span>
                </div>
              </SidebarMenuButton>
            </NavLink>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Operate</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{operate.map(renderItem)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>System</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{system.map(renderItem)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <NavLink to="/workers">
              <SidebarMenuButton size="lg" tooltip="Workers">
                <span
                  className={cn(
                    "mx-1.5 inline-block size-2 shrink-0 rounded-full",
                    workers?.total
                      ? workers.online === workers.total
                        ? "bg-emerald-500"
                        : "bg-amber-500"
                      : "bg-muted-foreground/40",
                  )}
                />
                <div className="grid text-left text-xs leading-tight">
                  <span className="font-medium">Workers</span>
                  <span className="text-muted-foreground">
                    {workers?.total ? `${workers.online} of ${workers.total} online` : "none paired"}
                  </span>
                </div>
              </SidebarMenuButton>
            </NavLink>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

function UserMenu() {
  const navigate = useNavigate()
  const client = useQueryClient()
  const session = authClient.useSession()
  const { theme, setTheme } = useTheme()
  const name = (session.data?.user as { username?: string } | undefined)?.username ?? session.data?.user.name ?? ""
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account menu">
          <Avatar className="size-8">
            <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="font-medium">{name}</div>
          <div className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
            <ShieldCheck className="size-3" />
            Two-factor on
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Theme</DropdownMenuLabel>
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

/** Signed-in layout: shadcn inset sidebar, breadcrumb header, user menu. */
export function AppShell() {
  useLiveUpdates()
  const location = useLocation()
  const base = `/${location.pathname.split("/")[1] ?? ""}`
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>{titles[base] ?? "n8n-ops"}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <div className="ml-auto">
            <UserMenu />
          </div>
        </header>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  )
}

/** Standard padded page with a title. */
export function Page({
  title,
  description,
  actions,
  children,
}: {
  title?: string
  description?: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex-1 space-y-6 p-4 md:p-6">
      {(title || actions) && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            {title && <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>}
            {description && <p className="text-muted-foreground">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </div>
  )
}

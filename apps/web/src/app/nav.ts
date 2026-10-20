import {
  Bug,
  Cpu,
  DatabaseBackup,
  KeyRound,
  LayoutDashboard,
  Plug,
  ScrollText,
  Server,
  Settings,
  UserRound,
  Workflow,
} from "lucide-react"

/** The pages of the navigation, in groups; the sidebar, the tab bar, the search and page titles use them. */
export type NavItem = { to: string; label: string; icon: typeof Bug; count?: "problems" | "access" }
export const operate: NavItem[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/problems", label: "Problems", icon: Bug, count: "problems" },
  { to: "/instances", label: "Instances", icon: Server },
  { to: "/workflows", label: "Workflows", icon: Workflow },
  { to: "/backups", label: "Backups", icon: DatabaseBackup },
]
/** Agents: connecting them first, then the access they ask for. */
export const agents: NavItem[] = [
  { to: "/agents", label: "Connected Agents", icon: Plug },
  { to: "/access", label: "Agent Access", icon: KeyRound, count: "access" },
]
export const system: NavItem[] = [
  { to: "/workers", label: "Workers", icon: Cpu },
  { to: "/settings", label: "Settings", icon: Settings },
  { to: "/audit", label: "Audit Log", icon: ScrollText },
]
export const groups = [
  { label: "Operate", items: operate },
  { label: "Agents", items: agents },
  { label: "System", items: system },
]
/** The signed-in person's own pages, opened from the account menu instead of the navigation. */
export const personal: NavItem[] = [{ to: "/account", label: "Account", icon: UserRound }]
/** Every page, also those outside the navigation: page titles, icons and the search use it. */
export const pageGroups = [...groups, { label: "You", items: personal }]

export const isActive = (item: NavItem, pathname: string) =>
  item.to === "/" ? pathname === "/" : pathname === item.to || pathname.startsWith(`${item.to}/`)

/** The page of an address, and the group it belongs to. */
export function pageOf(pathname: string) {
  for (const g of pageGroups) {
    const item = g.items.find((i) => isActive(i, pathname))
    if (item) return { group: g.label, item }
  }
  return null
}

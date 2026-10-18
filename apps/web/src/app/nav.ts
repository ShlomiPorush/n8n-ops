import {
  Bug,
  Cpu,
  DatabaseBackup,
  KeyRound,
  LayoutDashboard,
  ScrollText,
  Server,
  Settings,
  Workflow,
} from "lucide-react"

/** The pages of the navigation, in two groups; the sidebar, the tab bar, the search and page titles use them. */
export type NavItem = { to: string; label: string; icon: typeof Bug; count?: "problems" | "access" }
export const operate: NavItem[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/problems", label: "Problems", icon: Bug, count: "problems" },
  { to: "/instances", label: "Instances", icon: Server },
  { to: "/workflows", label: "Workflows", icon: Workflow },
  { to: "/backups", label: "Backups", icon: DatabaseBackup },
  { to: "/access", label: "Agent access", icon: KeyRound, count: "access" },
]
export const system: NavItem[] = [
  { to: "/workers", label: "Workers", icon: Cpu },
  { to: "/settings", label: "Settings", icon: Settings },
  { to: "/audit", label: "Audit log", icon: ScrollText },
]
export const groups = [
  { label: "Operate", items: operate },
  { label: "System", items: system },
]

export const isActive = (item: NavItem, pathname: string) =>
  item.to === "/" ? pathname === "/" : pathname === item.to || pathname.startsWith(`${item.to}/`)

/** The page of an address, and the navigation group it belongs to. */
export function pageOf(pathname: string) {
  for (const g of groups) {
    const item = g.items.find((i) => isActive(i, pathname))
    if (item) return { group: g.label, item }
  }
  return null
}

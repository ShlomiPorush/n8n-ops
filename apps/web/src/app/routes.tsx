import type { RouteObject } from "react-router"
import { AuditPage } from "@/pages/audit"
import { PlaceholderPage } from "@/pages/placeholder"
import { SettingsPage } from "@/pages/settings"

/** Pages inside the signed-in shell. */
export const routes: RouteObject[] = [
  { index: true, element: <PlaceholderPage title="Overview" /> },
  { path: "problems/:id?", element: <PlaceholderPage title="Problems" /> },
  { path: "instances/:id?", element: <PlaceholderPage title="Instances" /> },
  { path: "workflows", element: <PlaceholderPage title="Workflows" /> },
  { path: "backups/:id?", element: <PlaceholderPage title="Backups" /> },
  { path: "workers", element: <PlaceholderPage title="Workers" /> },
  { path: "settings/:section?", element: <SettingsPage /> },
  { path: "audit", element: <AuditPage /> },
]

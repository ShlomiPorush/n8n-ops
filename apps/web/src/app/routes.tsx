import type { RouteObject } from "react-router"
import { AuditPage } from "@/pages/audit"
import { InstancesPage } from "@/pages/instances"
import { OverviewPage } from "@/pages/overview"
import { PlaceholderPage } from "@/pages/placeholder"
import { ProblemsPage } from "@/pages/problems"
import { SettingsPage } from "@/pages/settings"

/** Pages inside the signed-in shell. */
export const routes: RouteObject[] = [
  { index: true, element: <OverviewPage /> },
  { path: "problems/:id?", element: <ProblemsPage /> },
  { path: "instances/:id?", element: <InstancesPage /> },
  { path: "workflows", element: <PlaceholderPage title="Workflows" /> },
  { path: "backups/:id?", element: <PlaceholderPage title="Backups" /> },
  { path: "workers", element: <PlaceholderPage title="Workers" /> },
  { path: "settings/:section?", element: <SettingsPage /> },
  { path: "audit", element: <AuditPage /> },
]

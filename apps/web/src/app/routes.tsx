import { Navigate, type RouteObject } from "react-router"
import { AccessPage } from "@/pages/access"
import { AccountPage } from "@/pages/account"
import { AgentsPage } from "@/pages/agents"
import { ArchivePage } from "@/pages/archive"
import { AuditPage } from "@/pages/audit"
import { BackupsPage } from "@/pages/backups"
import { InstanceSetupPage } from "@/pages/instance-setup"
import { InstancesPage } from "@/pages/instances"
import { OverviewPage } from "@/pages/overview"
import { ProblemsPage } from "@/pages/problems"
import { SettingsPage } from "@/pages/settings"
import { WorkersPage } from "@/pages/workers"
import { WorkflowsPage } from "@/pages/workflows"

/** Pages inside the signed-in shell. */
export const routes: RouteObject[] = [
  { index: true, element: <OverviewPage /> },
  { path: "problems/:id?", element: <ProblemsPage /> },
  // The setup of a new instance, or of capabilities added to one, before the instance pages take the rest.
  { path: "instances/new", element: <InstanceSetupPage /> },
  { path: "instances/:id/setup", element: <InstanceSetupPage /> },
  { path: "instances/:id?", element: <InstancesPage /> },
  { path: "workflows", element: <WorkflowsPage /> },
  // One archive of a backup, and the item open in it; before the backups pages take the rest.
  { path: "backups/:id/runs/:runId/:kind?/:itemId?", element: <ArchivePage /> },
  // The Version before replace a restore kept opens on the same page.
  { path: "backups/:id/versions/:restoreId/:kind?/:itemId?", element: <ArchivePage /> },
  { path: "backups/:id?", element: <BackupsPage /> },
  { path: "access/:id?", element: <AccessPage /> },
  { path: "agents", element: <AgentsPage /> },
  { path: "workers", element: <WorkersPage /> },
  // Both were sections of Settings; old links and bookmarks still land on them.
  { path: "settings/tokens", element: <Navigate to="/agents" replace /> },
  { path: "settings/account", element: <Navigate to="/account" replace /> },
  { path: "settings/:section?", element: <SettingsPage /> },
  { path: "audit", element: <AuditPage /> },
  { path: "account", element: <AccountPage /> },
]

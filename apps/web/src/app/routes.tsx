import { Navigate, type RouteObject } from "react-router"
import { AccessPage } from "@/pages/access"
import { AccountPage } from "@/pages/account"
import { AgentsPage } from "@/pages/agents"
import { AuditPage } from "@/pages/audit"
import { BackupsPage } from "@/pages/backups"
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
  { path: "instances/:id?", element: <InstancesPage /> },
  { path: "workflows", element: <WorkflowsPage /> },
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

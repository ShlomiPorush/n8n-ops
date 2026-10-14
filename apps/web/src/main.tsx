import { QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { createBrowserRouter, Navigate, RouterProvider } from "react-router"
import "./index.css"
import { routes } from "@/app/routes"
import { AppShell, RequireAuth } from "@/app/shell"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { queryClient } from "@/lib/api"
import { useSystemTheme } from "@/lib/theme"
import { LoginPage } from "@/pages/auth/login"
import { SetupPage } from "@/pages/auth/setup"

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/setup", element: <SetupPage /> },
  {
    element: <RequireAuth />,
    children: [{ element: <AppShell />, children: routes }],
  },
  { path: "*", element: <Navigate to="/" replace /> },
])

function Root() {
  useSystemTheme()
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)

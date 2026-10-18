import { QueryClientProvider } from "@tanstack/react-query"
import { ThemeProvider } from "next-themes"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { createBrowserRouter, Navigate, RouterProvider } from "react-router"
import "./index.css"
import { routes } from "@/app/routes"
import { AppShell, RequireAuth } from "@/app/shell"
import { ConfirmProvider } from "@/components/confirm"
import { Toaster } from "@/components/ui/toaster"
import { TooltipProvider } from "@/components/ui/tooltip"
import { queryClient } from "@/lib/api"
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
  return (
    // Light, dark or the operating system (default); the choice is kept in this browser.
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="n8n-ops-theme"
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ConfirmProvider>
            <RouterProvider router={router} />
          </ConfirmProvider>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  )
}

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)

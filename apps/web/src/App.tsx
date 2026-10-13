import type { Health } from "@n8n-ops/shared"
import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { describeHealth, fetchHealth } from "@/lib/health"

function useSystemTheme() {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const apply = () => document.documentElement.classList.toggle("dark", media.matches)
    apply()
    media.addEventListener("change", apply)
    return () => media.removeEventListener("change", apply)
  }, [])
}

export function App() {
  useSystemTheme()
  const [health, setHealth] = useState<Health | "unreachable" | null>(null)

  useEffect(() => {
    void fetchHealth().then(setHealth)
  }, [])

  const view = describeHealth(health)
  const version = health && health !== "unreachable" ? health.version : undefined

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            <h1 className="text-2xl font-semibold">n8n-ops</h1>
          </CardTitle>
          <CardDescription>Foundation build. No features yet.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <Badge variant={view.tone === "error" ? "destructive" : view.tone === "ok" ? "default" : "secondary"}>
            {view.label}
          </Badge>
          {version && <span className="text-sm text-muted-foreground">v{version}</span>}
        </CardContent>
      </Card>
    </main>
  )
}

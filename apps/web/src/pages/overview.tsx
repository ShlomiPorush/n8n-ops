import {
  ArrowRight,
  Bug,
  CircleCheck,
  CircleX,
  Cpu,
  DatabaseBackup,
  KeyRound,
  type LucideIcon,
  RotateCcw,
  Server,
  Siren,
  Sparkles,
  TriangleAlert,
} from "lucide-react"
import { Link, useNavigate } from "react-router"
import { Page } from "@/app/shell"
import { EmptyState } from "@/components/empty-state"
import { StatCard } from "@/components/stat-card"
import { Dot, type HealthState, TimeAgo, Tone, type ToneName, timeAgo } from "@/components/status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useApi } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { InstanceRow } from "./instances"

type AttentionItem =
  | {
      kind: "problem"
      id: string
      reason: "new" | "regression"
      workflowName: string
      instanceName: string
      errorMessage: string
      count: number
      at: string
    }
  | { kind: "instance"; id: string; name: string; health: string; detail: string; at: string | null }
  | { kind: "backup"; id: string; name: string; detail: string; at: string | null }
  | { kind: "worker"; id: string; name: string; at: string | null }
  | { kind: "access"; id: string; name: string; detail: string; at: string | null }

type Overview = {
  attention: AttentionItem[]
  stats: {
    instances: number
    healthy: number
    down: number
    warn: number
    openProblems: number
    lastBackupAt: string | null
  }
}

type AuditEntry = { id: number; at: string; actor: string; action: string; target: string; via: string }

/** How each kind of attention item is labelled, coloured and opened. */
function describe(a: AttentionItem): {
  tone: ToneName
  icon: LucideIcon
  label: string
  title: string
  where: string
  to: string
} {
  switch (a.kind) {
    case "problem":
      return {
        tone: "red",
        icon: a.reason === "regression" ? RotateCcw : Sparkles,
        label: a.reason === "regression" ? "Regression" : "New problem",
        title: a.workflowName,
        where: `${a.instanceName} · ${a.count} ${a.count === 1 ? "failure" : "failures"}`,
        to: `/problems/${a.id}`,
      }
    case "instance":
      return {
        tone: a.health === "down" ? "red" : "amber",
        icon: a.health === "down" ? CircleX : TriangleAlert,
        label: a.health === "down" ? "Down" : "Needs a look",
        title: a.detail,
        where: a.name,
        to: `/instances/${a.id}`,
      }
    case "backup":
      return {
        tone: "amber",
        icon: DatabaseBackup,
        label: "Backup",
        title: a.detail,
        where: a.name,
        to: `/backups/${a.id}`,
      }
    case "access":
      return {
        tone: "amber",
        icon: KeyRound,
        label: "Access request",
        title: a.detail,
        where: a.name,
        to: `/access/${a.id}`,
      }
    case "worker":
      return {
        tone: "red",
        icon: Cpu,
        label: "Worker offline",
        title: `${a.name} is not reporting`,
        where: a.name,
        to: "/workers",
      }
  }
}

export function OverviewPage() {
  const navigate = useNavigate()
  const overview = useApi<Overview>("/overview", { refetchInterval: 15_000 })
  const checklist = useApi<{ telegram: boolean; storage: boolean; instance: boolean }>("/setup/checklist")
  const instances = useApi<{ latestVersion: string | null; instances: InstanceRow[] }>("/instances", {
    refetchInterval: 15_000,
  })
  const activity = useApi<AuditEntry[]>("/admin/audit", { refetchInterval: 30_000 })
  if (overview.isLoading)
    return (
      <Page title="Overview">
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {[0, 1, 2, 3].map((n) => (
            <Skeleton key={n} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </Page>
    )
  const o = overview.data
  const order: Record<string, number> = { down: 0, warn: 1, unknown: 2, ok: 3 }
  const tiles = [...(instances.data?.instances ?? [])].sort(
    (a, b) => (order[a.health] ?? 9) - (order[b.health] ?? 9) || b.openProblems - a.openProblems,
  )
  const attention = o?.attention ?? []
  const unhealthy = (o?.stats.down ?? 0) + (o?.stats.warn ?? 0)
  const missing = checklist.data
    ? [
        !checklist.data.instance && { to: "/instances", label: "Add an n8n instance" },
        !checklist.data.telegram && { to: "/settings/telegram", label: "Connect Telegram for alerts" },
        !checklist.data.storage && { to: "/settings/storage", label: "Set backup storage" },
      ].filter((x): x is { to: string; label: string } => Boolean(x))
    : []
  // Agents' reads are noisy, and a run of sign-ins says little more than the latest one.
  const events = (activity.data ?? [])
    .filter((e) => e.action !== "MCP read")
    .filter((e, i, all) => e.action !== "Login" || all.findIndex((x) => x.action === "Login") === i)
    .slice(0, 8)

  return (
    <Page title="Overview">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard
          label="Need attention"
          value={attention.length}
          icon={Siren}
          tone={attention.length ? "red" : "default"}
          hint={attention.length ? "Listed below" : "All clear"}
        />
        <StatCard
          label="Instances healthy"
          value={o?.stats.healthy ?? 0}
          total={o?.stats.instances ?? 0}
          icon={Server}
          tone={o?.stats.down ? "red" : o?.stats.warn ? "amber" : "default"}
          hint={unhealthy ? `${o?.stats.down} down, ${o?.stats.warn} need a look` : "Every instance answers"}
        />
        <StatCard label="Open problems" value={o?.stats.openProblems ?? 0} icon={Bug} hint="Across all instances" />
        <StatCard
          label="Last backup"
          value={<TimeAgo value={o?.stats.lastBackupAt} />}
          icon={DatabaseBackup}
          hint={o?.stats.lastBackupAt ? new Date(o.stats.lastBackupAt).toLocaleString() : "No backup yet"}
        />
      </div>

      {missing.length > 0 && (
        <Card className="border-amber-500/40 bg-amber-50/40 dark:bg-amber-400/5">
          <CardHeader>
            <CardTitle>Finish setting up</CardTitle>
            <CardDescription>A few steps are left before n8n-ops can do everything.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-row flex-wrap gap-2">
            {missing.map((m) => (
              <Button key={m.to} variant="outline" size="sm" asChild>
                <Link to={m.to}>
                  {m.label} <ArrowRight />
                </Link>
              </Button>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
            <CardDescription>
              Agents waiting for access, new problems and regressions from the last 24 hours, health issues, stale
              backups, offline workers.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {attention.length ? (
              <ul className="divide-y rounded-lg border">
                {attention.map((a) => {
                  const d = describe(a)
                  return (
                    <li key={`${a.kind}:${a.id}`}>
                      <button
                        type="button"
                        onClick={() => navigate(d.to)}
                        className="flex w-full flex-col items-start gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/50 sm:flex-row sm:gap-3"
                      >
                        <Tone tone={d.tone} icon={d.icon} className="mt-0.5">
                          {d.label}
                        </Tone>
                        <div className="w-full min-w-0 flex-1">
                          <div className="truncate font-medium">{d.title}</div>
                          {a.kind === "problem" && (
                            <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                              {a.errorMessage}
                            </div>
                          )}
                          <div className="mt-0.5 text-xs text-muted-foreground">{d.where}</div>
                        </div>
                        <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
                          {timeAgo(a.at)}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <EmptyState
                icon={CircleCheck}
                title="Nothing needs you right now"
                description="New problems, health issues, stale backups and access requests show up here."
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>Sign-ins, changes and decisions, newest first.</CardDescription>
          </CardHeader>
          <CardContent>
            {events.length ? (
              <ol className="relative space-y-4 border-l pl-5">
                {events.map((e) => (
                  <li key={e.id} className="relative">
                    <span className="absolute top-1.5 -left-[23.5px] size-2 rounded-full bg-muted-foreground/40 ring-4 ring-card" />
                    <div className="text-sm">
                      <span className="font-medium">{e.action}</span>
                      {e.target && <span className="text-muted-foreground"> · {e.target}</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {e.actor} · {timeAgo(e.at)}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing yet.</p>
            )}
            <Button variant="link" className="mt-3 px-0" asChild>
              <Link to="/audit">
                Full audit log <ArrowRight />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Instances</h2>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <Dot health="down" />
            Down
          </span>
          <span className="flex items-center gap-2">
            <Dot health="warn" />
            Needs a look
          </span>
          <span className="flex items-center gap-2">
            <Dot health="ok" />
            Healthy
          </span>
        </div>
      </div>
      {tiles.length === 0 ? (
        <EmptyState
          icon={Server}
          title="No instances yet"
          description="Add your n8n instances to start watching them."
          action={
            <Button asChild>
              <Link to="/instances">Add an instance</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {tiles.map((i) => (
            <Tile key={i.id} i={i} onOpen={() => navigate(`/instances/${i.id}`)} />
          ))}
        </div>
      )}
    </Page>
  )
}

function Tile({ i, onOpen }: { i: InstanceRow; onOpen: () => void }) {
  const note =
    i.health === "down"
      ? "Not responding"
      : i.health === "warn"
        ? "Needs a look"
        : i.health === "unknown"
          ? "Not checked yet"
          : "Healthy"
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex flex-col gap-4 rounded-xl border bg-card p-5 text-left shadow-xs transition-all hover:-translate-y-0.5 hover:shadow-md",
        i.health === "down" && "border-rose-500/50",
        i.health === "warn" && "border-amber-500/50",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Dot health={i.health as HealthState} />
            {note}
          </div>
          <div className="mt-1 truncate text-xl font-semibold tracking-tight">{i.name}</div>
        </div>
        {i.version && (
          <Badge variant="outline" className="font-mono">
            {i.version}
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-4 border-t pt-3 text-sm text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Bug className="size-3.5" />
          <b className={cn("font-semibold text-foreground", i.openProblems > 0 && "text-rose-600 dark:text-rose-400")}>
            {i.openProblems}
          </b>{" "}
          open
        </span>
        <span className="flex items-center gap-1.5">
          <DatabaseBackup className="size-3.5" />
          {i.lastBackup ? (
            <span className={cn(i.lastBackup.status === "failed" && "text-destructive")}>
              {timeAgo(i.lastBackup.at)}
            </span>
          ) : (
            "never"
          )}
        </span>
        <ArrowRight className="ml-auto size-4 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
    </button>
  )
}

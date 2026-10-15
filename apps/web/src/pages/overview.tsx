import { Link, useNavigate } from "react-router"
import { Page } from "@/app/shell"
import { Dot, type HealthState, TimeAgo, Tone } from "@/components/status"
import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
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

export function OverviewPage() {
  const navigate = useNavigate()
  const overview = useApi<Overview>("/overview", { refetchInterval: 15_000 })
  const checklist = useApi<{ telegram: boolean; storage: boolean; instance: boolean }>("/setup/checklist")
  const instances = useApi<{ latestVersion: string | null; instances: InstanceRow[] }>("/instances", {
    refetchInterval: 15_000,
  })
  if (overview.isLoading)
    return (
      <Page>
        <Skeleton className="h-64" />
      </Page>
    )
  const o = overview.data
  const order: Record<string, number> = { down: 0, warn: 1, unknown: 2, ok: 3 }
  const tiles = [...(instances.data?.instances ?? [])].sort(
    (a, b) => (order[a.health] ?? 9) - (order[b.health] ?? 9) || b.openProblems - a.openProblems,
  )
  const open = (item: AttentionItem) =>
    navigate(
      item.kind === "problem"
        ? `/problems/${item.id}`
        : item.kind === "instance"
          ? `/instances/${item.id}`
          : item.kind === "backup"
            ? `/backups/${item.id}`
            : item.kind === "access"
              ? `/access/${item.id}`
              : "/workers",
    )

  return (
    <Page title="Overview">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard
          label="Need attention"
          value={o?.attention.length ?? 0}
          tone={o?.attention.length ? "red" : undefined}
        />
        <StatCard
          label="Instances healthy"
          value={`${o?.stats.healthy ?? 0}/${o?.stats.instances ?? 0}`}
          hint={o?.stats.down || o?.stats.warn ? `${o.stats.down} down, ${o.stats.warn} need a look` : undefined}
        />
        <StatCard label="Open problems" value={o?.stats.openProblems ?? 0} />
        <StatCard label="Last backup" value={<TimeAgo value={o?.stats.lastBackupAt} />} />
      </div>

      {checklist.data && (!checklist.data.telegram || !checklist.data.storage || !checklist.data.instance) && (
        <Card className="border-amber-500/50">
          <CardHeader>
            <CardTitle>Finish setting up</CardTitle>
            <CardDescription>
              {[
                !checklist.data.instance && (
                  <Link key="i" to="/instances" className="underline">
                    Add an n8n instance
                  </Link>
                ),
                !checklist.data.telegram && (
                  <Link key="t" to="/settings/telegram" className="underline">
                    connect Telegram for alerts
                  </Link>
                ),
                !checklist.data.storage && (
                  <Link key="s" to="/settings/storage" className="underline">
                    set backup storage
                  </Link>
                ),
              ]
                .filter(Boolean)
                .flatMap((el, i) => (i === 0 ? [el] : [", ", el]))}
              .
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Needs attention</CardTitle>
          <CardDescription>
            Agents waiting for access, new problems and regressions from the last 24 hours, health issues, stale
            backups, offline workers.
          </CardDescription>
        </CardHeader>
        <div className="px-6">
          {o?.attention.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>What</TableHead>
                  <TableHead>Where</TableHead>
                  <TableHead className="text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {o.attention.map((a) => (
                  <TableRow key={`${a.kind}:${a.id}`} className="cursor-pointer" onClick={() => open(a)}>
                    {a.kind === "problem" ? (
                      <>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Tone tone="red">{a.reason === "regression" ? "Regression" : "New problem"}</Tone>
                            <span className="font-medium">{a.workflowName}</span>
                          </div>
                          <div className="mt-1 max-w-lg truncate font-mono text-xs text-muted-foreground">
                            {a.errorMessage}
                          </div>
                        </TableCell>
                        <TableCell>
                          {a.instanceName}{" "}
                          <span className="text-muted-foreground">
                            · {a.count} {a.count === 1 ? "failure" : "failures"}
                          </span>
                        </TableCell>
                      </>
                    ) : (
                      <>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Tone tone={a.kind === "backup" || a.kind === "access" ? "amber" : "red"}>
                              {a.kind === "instance"
                                ? a.health === "down"
                                  ? "Down"
                                  : "Needs a look"
                                : a.kind === "backup"
                                  ? "Backup"
                                  : a.kind === "access"
                                    ? "Access request"
                                    : "Worker offline"}
                            </Tone>
                            <span className="font-medium">
                              {"detail" in a ? a.detail : `${a.name} is not reporting`}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>{a.name}</TableCell>
                      </>
                    )}
                    <TableCell className="text-right whitespace-nowrap text-muted-foreground">
                      <TimeAgo value={a.at} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="pb-2 text-sm text-muted-foreground">Nothing needs you right now.</p>
          )}
        </div>
      </Card>

      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-xl font-semibold">Instances</h2>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Dot health="down" />
            Down
          </span>
          <span className="flex items-center gap-1.5">
            <Dot health="warn" />
            Needs a look
          </span>
          <span className="flex items-center gap-1.5">
            <Dot health="ok" />
            Healthy
          </span>
        </div>
      </div>
      {tiles.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No instances yet</CardTitle>
            <CardDescription>Add your n8n instances on the Instances page.</CardDescription>
          </CardHeader>
        </Card>
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

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: React.ReactNode
  hint?: string
  tone?: "red"
}) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className={cn("text-2xl font-semibold tabular-nums", tone === "red" && "text-destructive")}>
          {value}
        </CardTitle>
      </CardHeader>
      {hint && <p className="px-4 text-xs text-muted-foreground">{hint}</p>}
    </Card>
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
    <Card
      className={cn(
        "cursor-pointer gap-3 transition-shadow hover:shadow-md",
        i.health === "down" && "border-destructive/60",
        i.health === "warn" && "border-amber-500/50",
      )}
      onClick={onOpen}
    >
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          <Dot health={i.health as HealthState} />
          {note}
        </CardDescription>
        <CardTitle className="text-2xl font-semibold">{i.name}</CardTitle>
        <CardAction>{i.version && <Badge variant="outline">v{i.version}</Badge>}</CardAction>
      </CardHeader>
      <CardFooter className="gap-4 text-sm text-muted-foreground">
        <span>
          <b className="text-foreground">{i.openProblems}</b> open
        </span>
        <span>
          backup{" "}
          {i.lastBackup ? (
            <span className={cn(i.lastBackup.status === "failed" && "text-destructive")}>
              <TimeAgo value={i.lastBackup.at} />
            </span>
          ) : (
            "never"
          )}
        </span>
      </CardFooter>
    </Card>
  )
}

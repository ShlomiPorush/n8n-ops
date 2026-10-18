import { Link } from "react-router"
import { AlertRow, Empty, Kpi, Kpis, LoadError, Loading, Page, Panel, PanelHead, Row, UserText } from "@/components/kit"
import { Dot, type HealthState, StatusTag, statusOf, TimeAgo, Tone } from "@/components/status"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { useApi } from "@/lib/api"
import { n, plural } from "@/lib/time"
import { cn } from "@/lib/utils"
import { behind, type InstanceRow } from "./instances"

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

const target = (item: AttentionItem) =>
  item.kind === "problem"
    ? `/problems/${item.id}`
    : item.kind === "instance"
      ? `/instances/${item.id}`
      : item.kind === "backup"
        ? `/backups/${item.id}`
        : item.kind === "access"
          ? `/access/${item.id}`
          : "/workers"

export function OverviewPage() {
  const overview = useApi<Overview>("/overview", { refetchInterval: 15_000 })
  const checklist = useApi<{ telegram: boolean; storage: boolean; instance: boolean }>("/setup/checklist")
  const instances = useApi<{ latestVersion: string | null; instances: InstanceRow[] }>("/instances", {
    refetchInterval: 15_000,
  })
  const activity = useApi<AuditEntry[]>("/admin/audit", { refetchInterval: 30_000 })
  const o = overview.data
  const order: Record<string, number> = { down: 0, warn: 1, unknown: 2, ok: 3 }
  const rows = [...(instances.data?.instances ?? [])].sort(
    (a, b) => (order[a.health] ?? 9) - (order[b.health] ?? 9) || b.openProblems - a.openProblems,
  )
  const attention = o?.attention ?? []
  // Agents' reads are noisy, and a run of sign-ins says little more than the latest one.
  const events = (activity.data ?? [])
    .filter((e) => e.action !== "MCP read")
    .filter((e, i, all) => e.action !== "Login" || all.findIndex((x) => x.action === "Login") === i)
    .slice(0, 8)
  const setup = checklist.data
  const missing = setup
    ? [
        !setup.instance && (
          <Link key="i" to="/instances">
            Add an n8n instance
          </Link>
        ),
        !setup.telegram && (
          <Link key="t" to="/settings/telegram">
            connect Telegram for alerts
          </Link>
        ),
        !setup.storage && (
          <Link key="s" to="/settings/storage">
            set backup storage
          </Link>
        ),
      ].filter(Boolean)
    : []

  return (
    <Page
      title="Overview"
      updatedAt={overview.dataUpdatedAt || undefined}
      description={
        o
          ? `${plural(attention.length, "thing needs", "things need")} you · ${plural(o.stats.openProblems, "open problem")} across ${plural(o.stats.instances, "instance")}`
          : "What needs you now, and how each n8n instance is doing."
      }
    >
      {missing.length > 0 && (
        <Alert variant="warn">
          <AlertTitle>Finish setting up</AlertTitle>
          <AlertDescription>{missing.flatMap((el, i) => (i === 0 ? [el] : [", ", el]))}.</AlertDescription>
        </Alert>
      )}

      {overview.error ? (
        <Panel>
          <LoadError what="the overview" error={overview.error} retry={() => overview.refetch()} />
        </Panel>
      ) : !o ? (
        <Panel>
          <Loading>Loading the overview…</Loading>
        </Panel>
      ) : (
        <>
          <Kpis>
            <Kpi label="Need attention" value={n(attention.length)} tone={attention.length ? "fail" : undefined} />
            <Kpi
              label="Instances healthy"
              value={`${n(o.stats.healthy)}/${n(o.stats.instances)}`}
              hint={
                o.stats.down || o.stats.warn ? `${n(o.stats.down)} down, ${n(o.stats.warn)} need a look` : undefined
              }
              tone={o.stats.down ? "fail" : o.stats.warn ? "warn" : undefined}
              to="/instances"
            />
            <Kpi label="Open problems" value={n(o.stats.openProblems)} to="/problems?status=open" />
            <Kpi label="Last backup" value={<TimeAgo value={o.stats.lastBackupAt} />} to="/backups" />
          </Kpis>

          <div className="grid items-start gap-gap xl:grid-cols-[minmax(0,1.9fr)_minmax(260px,1fr)]">
            <Panel>
              <PanelHead
                title="Needs attention"
                count={attention.length ? n(attention.length) : undefined}
                description="Agents waiting for access, new problems and regressions from the last 24 hours, health issues, stale backups, offline workers."
              />
              {attention.length ? (
                attention.map((a) => <AttentionRow key={`${a.kind}:${a.id}`} a={a} />)
              ) : (
                <Empty title="Nothing needs you right now.">
                  New problems, health issues and requests show up here.
                </Empty>
              )}
            </Panel>

            <div className="grid min-w-0 gap-gap">
              <Panel>
                <PanelHead
                  title="Instances"
                  count={instances.data ? n(rows.length) : undefined}
                  more={rows.length ? { to: "/instances", label: "All instances" } : undefined}
                />
                {instances.error ? (
                  <LoadError what="instances" error={instances.error} retry={() => instances.refetch()} />
                ) : !instances.data ? (
                  <Loading />
                ) : rows.length === 0 ? (
                  <Empty
                    title="No instances yet."
                    action={
                      <Link to="/instances" className="font-semibold underline">
                        Add an instance
                      </Link>
                    }
                  >
                    Add your n8n instances on the Instances page.
                  </Empty>
                ) : (
                  rows.map((i) => <InstanceLine key={i.id} i={i} latest={instances.data?.latestVersion ?? null} />)
                )}
              </Panel>

              <Panel>
                <PanelHead
                  title="Recent activity"
                  description="Sign-ins, changes and decisions, newest first."
                  more={{ to: "/audit", label: "Full audit log" }}
                />
                {activity.error ? (
                  <LoadError what="recent activity" error={activity.error} retry={() => activity.refetch()} />
                ) : !activity.data ? (
                  <Loading />
                ) : events.length === 0 ? (
                  <Empty title="Nothing recorded yet.">Sign-ins and changes appear here.</Empty>
                ) : (
                  events.map((e) => (
                    <Row key={e.id} className="grid gap-0.5">
                      <span className="min-w-0">
                        <span className="font-semibold">{e.action}</span>
                        {e.target && (
                          <span className="text-muted-foreground">
                            {" · "}
                            <UserText>{e.target}</UserText>
                          </span>
                        )}
                      </span>
                      <span className="text-small text-muted-foreground">
                        <UserText>{e.actor}</UserText> · <TimeAgo value={e.at} />
                      </span>
                    </Row>
                  ))
                )}
              </Panel>
            </div>
          </div>
        </>
      )}
    </Page>
  )
}

function AttentionRow({ a }: { a: AttentionItem }) {
  if (a.kind === "problem")
    return (
      <AlertRow
        tone="fail"
        to={target(a)}
        title={
          <>
            <StatusTag kind="problem" status={a.reason === "regression" ? "regression" : "new"}>
              {a.reason === "regression" ? "Regression" : "New problem"}
            </StatusTag>
            <UserText className="font-semibold">{a.workflowName}</UserText>
            <span className="ms-auto text-meta text-muted-foreground">
              <TimeAgo value={a.at} />
            </span>
          </>
        }
      >
        <span className="block truncate font-mono text-[0.9em]">{a.errorMessage}</span>
        <span>
          <UserText>{a.instanceName}</UserText> · {plural(a.count, "failure")}
        </span>
      </AlertRow>
    )
  const tone = a.kind === "backup" || a.kind === "access" ? "warn" : "fail"
  const label =
    a.kind === "instance"
      ? statusOf("health", a.health === "down" ? "down" : "warn").label
      : a.kind === "backup"
        ? "Backup"
        : a.kind === "access"
          ? "Access request"
          : "Worker offline"
  return (
    <AlertRow
      tone={tone}
      to={target(a)}
      title={
        <>
          <Tone tone={tone}>{label}</Tone>
          <span className="font-semibold">{"detail" in a ? a.detail : `${a.name} is not reporting`}</span>
          <span className="ms-auto text-meta text-muted-foreground">
            <TimeAgo value={a.at} />
          </span>
        </>
      }
    >
      <UserText>{a.name}</UserText>
    </AlertRow>
  )
}

function InstanceLine({ i, latest }: { i: InstanceRow; latest: string | null }) {
  const health = i.health as HealthState
  const s = statusOf("health", health)
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-t border-s-3 border-line px-pad-x py-pad-y",
        s.tone === "ok" && "border-s-ok/55",
        s.tone === "warn" && "border-s-warn",
        s.tone === "fail" && "border-s-fail",
        s.tone === "muted" && "border-s-muted-foreground/40",
      )}
    >
      <Link to={`/instances/${i.id}`} className="flex min-w-0 items-center gap-2 font-semibold hover:underline">
        <Dot health={health} />
        <UserText className="truncate">{i.name}</UserText>
      </Link>
      <div className="flex items-center gap-1.5">
        {health !== "ok" && <StatusTag kind="health" status={health} />}
        {i.version && (
          <Badge
            variant={behind(i.version, latest) ? "warn" : "line"}
            title={latest ? `Latest is ${latest}` : undefined}
          >
            v{i.version}
          </Badge>
        )}
      </div>
      <div className="col-span-2 flex flex-wrap gap-x-3 text-small text-muted-foreground">
        <Link
          to={`/problems?status=open&instance=${i.id}`}
          className={cn("hover:underline", i.openProblems > 0 && "font-semibold text-fail")}
        >
          {n(i.openProblems)} open
        </Link>
        <span>
          backup{" "}
          {i.lastBackup ? (
            <span className={cn(i.lastBackup.status === "failed" && "font-semibold text-fail")}>
              <TimeAgo value={i.lastBackup.at} />
            </span>
          ) : (
            "never"
          )}
        </span>
      </div>
    </div>
  )
}

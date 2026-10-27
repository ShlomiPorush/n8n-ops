import {
  Bug as BugIcon,
  DatabaseBackup as DatabaseBackupIcon,
  Server as ServerIcon,
  Siren as SirenIcon,
} from "lucide-react"
import { Fragment } from "react"
import { Link } from "react-router"
import { AttentionList, attentionCount } from "@/components/attention"
import { Empty, Kpi, Kpis, LoadError, Loading, NoValue, Page, Panel, PanelHead, Row, UserText } from "@/components/kit"
import { StepArrow } from "@/components/skin/marks"
import { Dot, type HealthState, StatusTag, statusOf, TimeAgo } from "@/components/status"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Tip } from "@/components/ui/tooltip"
import { useApi } from "@/lib/api"
import { auditAction, auditTarget } from "@/lib/audit-text"
import { useAttention } from "@/lib/attention"
import { type Loadable, loadView } from "@/lib/load-state"
import { healthCounts, n, plural } from "@/lib/numbers"
import { cn } from "@/lib/utils"
import { behind, healthLabel, type InstanceRow, LastKnown } from "./instances"

type Overview = {
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

/* Regular: each missing setup step is an outline button with an arrow, starting with a capital (#29). */
const step =
  "regular:inline-flex regular:h-8 regular:items-center regular:gap-1.5 regular:rounded-sm regular:border regular:border-line regular:bg-bg regular:px-3 regular:text-ctl regular:font-medium regular:shadow-card regular:[@media(hover:hover)]:hover:bg-fill"
const stepText = "regular:inline-block regular:first-letter:uppercase"

/* Regular: recent activity as a timeline, a dot per entry on a line that joins them (#29). */
const timeline =
  "regular:relative regular:border-t-0 regular:ps-[calc(var(--spacing-pad-x)+22px)] regular:before:absolute regular:before:start-pad-x regular:before:top-[19px] regular:before:size-2 regular:before:rounded-full regular:before:bg-muted-foreground/40 regular:before:ring-4 regular:before:ring-panel regular:after:absolute regular:after:start-[calc(var(--spacing-pad-x)+3.5px)] regular:after:top-7 regular:after:-bottom-5 regular:after:w-px regular:after:bg-line regular:last:after:hidden"

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
  // The same list the bell opens on every page, from the same query (NL-19).
  const attention = useAttention()
  const a = attention.data
  // Before the first answer the figures say so and the panels are drawn already, so nothing jumps (FB-17).
  const pending = (q: Loadable) => <NoValue said={loadView(q) === "failed" ? "Could not load" : "Loading"} />
  // Agents' reads are noisy, and a run of sign-ins says little more than the latest one.
  const events = (activity.data ?? [])
    .filter((e) => e.action !== "MCP read")
    .filter((e, i, all) => e.action !== "Login" || all.findIndex((x) => x.action === "Login") === i)
    .slice(0, 8)
  const setup = checklist.data
  const missing = setup
    ? [
        !setup.instance && { key: "instance", to: "/instances", text: "Add an n8n instance" },
        !setup.telegram && { key: "telegram", to: "/settings/telegram", text: "connect Telegram for alerts" },
        !setup.storage && { key: "storage", to: "/settings/destinations", text: "add a backup destination" },
      ].filter((s) => s !== false)
    : []

  return (
    <Page
      title="Overview"
      // The line speaks for every block that refreshes here; Try again asks again only for those that failed. Needs
      // attention says so in its own panel, as it does under the bell.
      live={[overview, instances, activity]}
      description={
        o && a
          ? `${plural(a.total, "thing needs", "things need")} you · ${plural(o.stats.openProblems, "open problem")} across ${plural(o.stats.instances, "instance")}`
          : "What needs you now, and how each n8n instance is doing."
      }
    >
      {missing.length > 0 && (
        // Regular draws the banner as a warm card whose steps are buttons (#29); the words stay the same.
        <Alert
          variant="warn"
          className="regular:gap-1 regular:border regular:border-warm-line regular:bg-warm regular:p-6 regular:text-ink"
        >
          <AlertTitle className="regular:text-head regular:font-semibold">Finish setting up</AlertTitle>
          <AlertDescription className="regular:mt-3 regular:flex regular:flex-wrap regular:gap-2 regular:[&_a]:no-underline">
            {missing.map((s, i) => (
              <Fragment key={s.key}>
                {i > 0 && <span className="regular:hidden">, </span>}
                <Link to={s.to} className={step}>
                  {/* Compact reads the steps as one sentence: only its first word starts with a capital. */}
                  <span className={stepText}>
                    {i === 0 ? `${s.text.charAt(0).toUpperCase()}${s.text.slice(1)}` : s.text}
                  </span>
                  <StepArrow />
                </Link>
              </Fragment>
            ))}
            <span className="regular:hidden">.</span>
          </AlertDescription>
        </Alert>
      )}

      {loadView(overview) === "failed" && (
        <Panel>
          <LoadError what="the overview" error={overview.error} retry={() => overview.refetch()} />
        </Panel>
      )}
      <Kpis>
        <Kpi
          label="Need attention"
          icon={SirenIcon}
          value={a ? a.total : pending(attention)}
          // The worst of what needs a look, as the bell shows it (NL-19).
          tone={a?.tone === "fail" ? "fail" : a?.tone === "warn" ? "warn" : undefined}
        />
        <Kpi
          label="Instances healthy"
          icon={ServerIcon}
          value={
            o ? (
              <>
                {n(o.stats.healthy)}
                <span className="regular:text-muted-foreground">/{n(o.stats.instances)}</span>
              </>
            ) : (
              pending(overview)
            )
          }
          hint={o && (o.stats.down || o.stats.warn) ? healthCounts(o.stats.down, o.stats.warn) : undefined}
          tone={o?.stats.down ? "fail" : o?.stats.warn ? "warn" : undefined}
          to="/instances"
        />
        <Kpi
          label="Open problems"
          icon={BugIcon}
          value={o ? o.stats.openProblems : pending(overview)}
          to="/problems?status=open"
        />
        <Kpi
          label="Last backup"
          icon={DatabaseBackupIcon}
          value={o ? <TimeAgo value={o.stats.lastBackupAt} /> : pending(overview)}
          to="/backups"
        />
      </Kpis>

      <div className="grid items-start gap-gap xl:grid-cols-[minmax(0,1.9fr)_minmax(260px,1fr)]">
        <Panel>
          <PanelHead
            title="Needs Attention"
            count={attentionCount(a)}
            description="Agents waiting for access, new problems and regressions from the last 24 hours, health issues, failed or late backups, offline workers."
          />
          <AttentionList query={attention} place="panel" />
        </Panel>

        <div className="grid min-w-0 gap-gap">
          <Panel>
            <PanelHead
              title="Instances"
              count={instances.data ? n(rows.length) : undefined}
              more={rows.length ? { to: "/instances", label: "All instances" } : undefined}
            />
            {loadView(instances) === "failed" ? (
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
              title="Recent Activity"
              description="Sign-ins, changes and decisions, newest first."
              more={{ to: "/audit", label: "Full audit log" }}
            />
            {loadView(activity) === "failed" ? (
              <LoadError what="recent activity" error={activity.error} retry={() => activity.refetch()} />
            ) : !activity.data ? (
              <Loading />
            ) : events.length === 0 ? (
              <Empty title="Nothing recorded yet.">Sign-ins and changes appear here.</Empty>
            ) : (
              events.map((e) => (
                <Row key={e.id} className={cn("grid gap-0.5", timeline)}>
                  <span className="min-w-0">
                    <span className="font-semibold">{auditAction(e.action)}</span>
                    {e.target && (
                      <span className="text-muted-foreground">
                        {" · "}
                        <UserText>{auditTarget(e.target)}</UserText>
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
    </Page>
  )
}

function InstanceLine({ i, latest }: { i: InstanceRow; latest: string | null }) {
  const health = i.health as HealthState
  const s = statusOf("health", health)
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-t border-s-3 border-line px-pad-x py-pad-y regular:border-s-0",
        s.tone === "ok" && "border-s-ok/55",
        s.tone === "warn" && "border-s-warn",
        s.tone === "fail" && "border-s-fail",
        s.tone === "muted" && "border-s-muted-foreground/40",
      )}
    >
      <Link to={`/instances/${i.id}`} className="flex min-w-0 items-center gap-2 font-semibold hover:underline">
        <Dot health={health} label={healthLabel(i)} />
        <UserText className="truncate" title={i.name}>
          {i.name}
        </UserText>
      </Link>
      <div className="flex items-center gap-1.5">
        {health !== "ok" && (
          <StatusTag kind="health" status={health}>
            {i.unknownReason ? "Unknown" : undefined}
          </StatusTag>
        )}
        {i.version &&
          (latest ? (
            <Tip content={`Latest is ${latest}`}>
              <Badge variant={behind(i.version, latest) ? "warn" : "line"}>v{i.version}</Badge>
            </Tip>
          ) : (
            <Badge variant="line">v{i.version}</Badge>
          ))}
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
        <LastKnown instance={i} />
      </div>
    </div>
  )
}

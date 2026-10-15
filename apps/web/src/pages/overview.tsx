import { Link, useNavigate } from "react-router"
import { Page } from "@/app/shell"
import { Figure, Figures } from "@/components/figures"
import { Dot, type HealthState, TimeAgo, Tone, timeAgo } from "@/components/status"
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

const groups: { kind: AttentionItem["kind"]; label: string }[] = [
  { kind: "access", label: "Waiting for you" },
  { kind: "problem", label: "Failing workflows" },
  { kind: "instance", label: "Instance health" },
  { kind: "backup", label: "Backups" },
  { kind: "worker", label: "Workers" },
]

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The one sentence at the top: what the operator needs to know, in their own instance and workflow names. */
function statement(o: Overview): { line: string; detail: string } {
  const items = o.attention
  const { instances, healthy } = o.stats
  if (items.length === 0) {
    if (instances === 0) return { line: "No instances yet.", detail: "Add an n8n instance to start watching it." }
    return {
      line: instances === 1 ? "The instance is healthy." : `All ${instances} instances are healthy.`,
      detail: "No new failures in the last 24 hours and nothing waiting for you.",
    }
  }
  if (items.length === 1) {
    const [a] = items as [AttentionItem]
    const line =
      a.kind === "problem"
        ? `${a.workflowName} is failing.`
        : a.kind === "instance"
          ? `${a.name} ${a.health === "down" ? "is down." : "needs a look."}`
          : a.kind === "backup"
            ? `${a.name} is behind on backups.`
            : a.kind === "access"
              ? "An agent is waiting for access."
              : `${a.name} is not reporting.`
    const detail =
      a.kind === "problem"
        ? `${plural(a.count, "failure")} on ${a.instanceName}, the last ${timeAgo(a.at)}.`
        : "detail" in a
          ? `${a.detail}.`.replace(/\.\.$/, ".")
          : `Last seen ${timeAgo(a.at)}.`
    return { line, detail }
  }
  const counts = groups
    .map((g) => ({ g, n: items.filter((i) => i.kind === g.kind).length }))
    .filter((c) => c.n > 0)
    .map(({ g, n }) =>
      g.kind === "problem"
        ? plural(n, "failing workflow")
        : g.kind === "access"
          ? plural(n, "access request")
          : g.kind === "instance"
            ? plural(n, "instance", "instances") + (n === 1 ? " needs a look" : " need a look")
            : g.kind === "backup"
              ? plural(n, "late backup")
              : plural(n, "silent worker"),
    )
  return {
    line: `${items.length} things need you.`,
    detail: `${counts.join(", ")}. ${healthy} of ${instances} instances are healthy.`,
  }
}

function href(a: AttentionItem): string {
  if (a.kind === "problem") return `/problems/${a.id}`
  if (a.kind === "instance") return `/instances/${a.id}`
  if (a.kind === "backup") return `/backups/${a.id}`
  if (a.kind === "access") return `/access/${a.id}`
  return "/workers"
}

export function OverviewPage() {
  const navigate = useNavigate()
  const overview = useApi<Overview>("/overview", { refetchInterval: 15_000 })
  const checklist = useApi<{ telegram: boolean; storage: boolean; instance: boolean }>("/setup/checklist")
  const instances = useApi<{ latestVersion: string | null; instances: InstanceRow[] }>("/instances", {
    refetchInterval: 15_000,
  })
  if (overview.isLoading || !overview.data)
    return (
      <Page>
        <Skeleton className="h-64" />
      </Page>
    )
  const o = overview.data
  const said = statement(o)
  const order: Record<string, number> = { down: 0, warn: 1, unknown: 2, ok: 3 }
  const tiles = [...(instances.data?.instances ?? [])].sort(
    (a, b) => (order[a.health] ?? 9) - (order[b.health] ?? 9) || b.openProblems - a.openProblems,
  )
  const missing = checklist.data
    ? [
        !checklist.data.instance && { to: "/instances", text: "Add an n8n instance" },
        !checklist.data.telegram && { to: "/settings/telegram", text: "Connect Telegram for alerts" },
        !checklist.data.storage && { to: "/settings/storage", text: "Set backup storage" },
      ].filter((x): x is { to: string; text: string } => Boolean(x))
    : []

  return (
    <Page>
      <section className="grid gap-x-12 gap-y-8 pt-4 lg:grid-cols-12 lg:pt-10">
        <div className="space-y-4 lg:col-span-7">
          <h1 className="line-clamp-2 text-[clamp(2.25rem,0.8rem+4.2vw,4.5rem)] leading-[1.0] font-medium tracking-[-0.025em] break-words">
            <span className="sr-only">Overview: </span>
            {said.line}
          </h1>
          <p className="max-w-[52ch]">{said.detail}</p>
        </div>
        {o.stats.instances > 0 && (
          <Figures className="gap-y-4 self-end lg:col-span-5">
            <Figure value={`${o.stats.healthy}/${o.stats.instances}`} tone={o.stats.down ? "down" : undefined}>
              instances healthy
              {[
                o.stats.down ? `${o.stats.down} down` : "",
                o.stats.warn ? `${o.stats.warn} ${o.stats.warn === 1 ? "needs" : "need"} a look` : "",
              ]
                .filter(Boolean)
                .map((part) => `, ${part}`)
                .join("")}
            </Figure>
            <Figure value={o.stats.openProblems}>
              {o.stats.openProblems === 1 ? "open problem" : "open problems"}
            </Figure>
            <Figure value={o.stats.lastBackupAt ? timeAgo(o.stats.lastBackupAt).replace(/ ago$/, "") : "none"}>
              {o.stats.lastBackupAt ? "since the last backup" : "backups so far"}
            </Figure>
          </Figures>
        )}
      </section>

      {missing.length > 0 && (
        <section className="space-y-3 rounded-md bg-warn-soft p-5 lg:max-w-[calc(7/12*100%)]">
          <h2 className="text-xl font-medium">Finish setting up</h2>
          <ul className="space-y-1">
            {missing.map((m) => (
              <li key={m.to}>
                <Link to={m.to} className="underline">
                  {m.text}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-5 pt-6" aria-labelledby="attention">
        <div className="space-y-1">
          <h2 id="attention" className="text-xl font-medium">
            Needs attention
          </h2>
          <p className="max-w-[62ch] text-muted-foreground">
            Agents waiting for access, new problems and regressions from the last 24 hours, health issues, late backups
            and silent workers.
          </p>
        </div>
        {o.attention.length === 0 ? (
          <p>Nothing needs you right now.</p>
        ) : (
          <div className="space-y-7 lg:max-w-[calc(9/12*100%)]">
            {groups.map((g) => {
              const items = o.attention.filter((a) => a.kind === g.kind)
              if (items.length === 0) return null
              return (
                <div key={g.kind} className="space-y-1">
                  <h3 className="text-muted-foreground">{g.label}</h3>
                  <ul className="-mx-3">
                    {items.map((a) => (
                      <li key={`${a.kind}:${a.id}`}>
                        <AttentionRow a={a} />
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="space-y-5 pt-6" aria-labelledby="instances">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h2 id="instances" className="text-xl font-medium">
            Instances
          </h2>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
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
          <p>
            No instances yet.{" "}
            <Link to="/instances" className="underline">
              Add your n8n instances
            </Link>
            .
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {tiles.map((i) => (
              <Tile key={i.id} i={i} onOpen={() => navigate(`/instances/${i.id}`)} />
            ))}
          </div>
        )}
      </section>
    </Page>
  )
}

/** One row, two ends: what and where on the left, when on the right. */
function AttentionRow({ a }: { a: AttentionItem }) {
  const tag =
    a.kind === "problem" ? (
      <Tone tone="red">{a.reason === "regression" ? "Regression" : "New problem"}</Tone>
    ) : a.kind === "instance" ? (
      <Tone tone={a.health === "down" ? "red" : "amber"}>{a.health === "down" ? "Down" : "Needs a look"}</Tone>
    ) : a.kind === "backup" ? (
      <Tone tone="amber">Late</Tone>
    ) : a.kind === "access" ? (
      <Tone tone="amber">Access request</Tone>
    ) : (
      <Tone tone="red">Silent</Tone>
    )
  const title = a.kind === "problem" ? a.workflowName : a.kind === "worker" ? `${a.name} is not reporting` : a.detail
  const where =
    a.kind === "problem" ? `${a.instanceName} · ${a.count} ${a.count === 1 ? "failure" : "failures"}` : a.name
  return (
    <Link
      to={href(a)}
      className="grid grid-cols-[1fr_auto] items-baseline gap-x-6 rounded-md px-3 py-2.5 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="min-w-0 space-y-0.5">
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {tag}
          <span className="font-medium">{title}</span>
        </span>
        <span className="block truncate text-muted-foreground">
          {a.kind === "problem" ? `${where}: ${a.errorMessage}` : where}
        </span>
      </span>
      <span className="text-xs whitespace-nowrap text-muted-foreground">
        <TimeAgo value={a.at} />
      </span>
    </Link>
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
  const down = i.health === "down"
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex min-h-36 flex-col justify-between gap-6 rounded-md p-5 text-left transition-[background-color,transform] active:scale-[0.99]",
        down
          ? "bg-down text-down-foreground hover:bg-[color-mix(in_oklch,var(--down),black_8%)]"
          : i.health === "warn"
            ? "bg-warn-soft hover:bg-[color-mix(in_oklch,var(--warn-soft),var(--foreground)_6%)]"
            : "bg-card hover:bg-[color-mix(in_oklch,var(--card),var(--foreground)_6%)]",
      )}
    >
      <span className="space-y-1">
        <span className="block truncate text-xl font-medium">{i.name}</span>
        <span className={cn("flex items-center gap-2", down ? "text-down-foreground" : "text-muted-foreground")}>
          {!down && <Dot health={i.health as HealthState} />}
          {note}
        </span>
      </span>
      <span className={cn("flex flex-wrap gap-x-4 gap-y-1 text-xs", !down && "text-muted-foreground")}>
        <span>
          <b className={cn("font-medium", !down && "text-foreground")}>{i.openProblems}</b> open
        </span>
        <span className={cn(!down && i.lastBackup?.status === "failed" && "text-down")}>
          backup {i.lastBackup ? <TimeAgo value={i.lastBackup.at} /> : "never"}
        </span>
        {i.version && <span>v{i.version}</span>}
      </span>
    </button>
  )
}

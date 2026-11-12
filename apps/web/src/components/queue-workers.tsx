import { CircleCheckIcon, CpuIcon, MemoryStickIcon, TagIcon } from "lucide-react"
import { Kpi, Kpis } from "@/components/kit"
import { Dot } from "@/components/status"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  byName,
  type QueueWorkerRow,
  type WorkersFigure,
  workerCells,
  workersOverview,
  workersSummary,
} from "@/lib/queue-workers"
import { cn } from "@/lib/utils"

/** Four figures in a pane: two by two, all in one row where there is room, never three over one. */
export const fourFigures =
  "grid-cols-2 compact:grid-cols-2 @min-[48rem]/pane:grid-cols-4 compact:@min-[48rem]/pane:grid-cols-4"

/*
 * The queue workers of an instance on its Health tab. What is the same on all of them is said once, in the figures
 * above them (ready, jobs at once, memory, n8n), and the table keeps what differs between them, one row each, so a
 * worker that stands out is seen down a column. Where something is wrong the row says it under the worker's name.
 * In a narrow pane or on a phone the table stacks, as every table does, each value labelled with its column.
 * `past` shows what the last check read: no tones, and the dots grey.
 */
export function QueueWorkers({
  rows,
  mainVersion,
  found,
  past,
}: {
  rows: QueueWorkerRow[]
  /** The main's version read inside in the same check, the only one a worker's is compared with. */
  mainVersion?: string
  /** How many the worker found, when more than it checked. */
  found?: number
  past: boolean
}) {
  if (rows.length === 0) return null
  const sorted = [...rows].sort(byName)
  const figures = workersOverview(sorted, mainVersion)
  const tone = (f: WorkersFigure) => (past ? undefined : f.tone)
  const value = (f: WorkersFigure) => (
    <>
      {f.value}
      {f.of && <span className="text-body font-medium whitespace-nowrap text-muted-foreground"> of {f.of}</span>}
    </>
  )
  // A long word in a line under a figure (N8N_CONCURRENCY_PRODUCTION_LIMIT) breaks rather than leave its card.
  const hint = (f: WorkersFigure) => <span className="[overflow-wrap:anywhere]">{f.hint}</span>
  // Ready alone says what the line above says already: the figures show when a check read more than that.
  const shown = [figures.jobs, figures.memory, figures.version].filter(Boolean).length
  const columns = shown === 3 ? fourFigures : shown === 2 ? "grid-cols-3 compact:grid-cols-3" : "grid-cols-2 compact:grid-cols-2"
  // Jobs at once are said per row only when they come from different places.
  const sources = new Set(sorted.flatMap((r) => (r.concurrency ? [r.concurrency.from] : [])))

  return (
    <>
      <div className="border-t border-line px-pad-x py-pad-y font-semibold" data-testid="queue-workers-summary">
        {workersSummary(sorted, { found, past })}
      </div>
      {shown > 0 && (
        <div className="px-pad-x pb-pad-y" data-testid="queue-workers-figures">
          <Kpis className={columns}>
            <Kpi
              label="Ready"
              icon={CircleCheckIcon}
              value={value(figures.ready)}
              hint={hint(figures.ready)}
              tone={tone(figures.ready)}
            />
            {figures.jobs && (
              <Kpi label="Jobs at once" icon={CpuIcon} value={value(figures.jobs)} hint={hint(figures.jobs)} />
            )}
            {figures.memory && (
              <Kpi label="Memory" icon={MemoryStickIcon} value={value(figures.memory)} hint={hint(figures.memory)} />
            )}
            {figures.version && (
              <Kpi
                label="n8n"
                icon={TagIcon}
                value={value(figures.version)}
                hint={hint(figures.version)}
                tone={tone(figures.version)}
              />
            )}
          </Kpis>
        </div>
      )}
      {/* No Sort button (TB-28): the workers stay in name order, worker2 before worker10. */}
      <Table bare>
        <TableHeader>
          <TableRow>
            <TableHead>Worker</TableHead>
            <TableHead>State</TableHead>
            <TableHead className="text-end">Up for</TableHead>
            <TableHead className="text-end">Jobs at once</TableHead>
            <TableHead>Memory</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((w) => {
            const c = workerCells(w, mainVersion)
            const read = c.uptime || c.jobs || c.memory
            const bad = !past && c.health !== "ok"
            return (
              <TableRow
                key={w.url}
                data-testid="queue-worker"
                className={cn(bad && (c.health === "down" ? "bg-fail/6" : "bg-warn/6"))}
              >
                <TableCell className="align-top whitespace-normal">
                  <span className="block font-semibold break-words">{w.name ?? w.url}</span>
                  {c.error && (
                    <span
                      className={cn(
                        "block text-small break-words",
                        past ? "text-muted-foreground" : c.health === "down" ? "text-fail" : "text-warn",
                      )}
                    >
                      {c.error}
                    </span>
                  )}
                  {c.version && (
                    <span
                      className={cn(
                        "block text-small [overflow-wrap:anywhere]",
                        past ? "text-muted-foreground" : "font-medium text-warn",
                      )}
                    >
                      n8n {c.version.version}, the main runs {c.version.main}
                    </span>
                  )}
                </TableCell>
                <TableCell className="align-top whitespace-normal">
                  <span
                    className={cn(
                      "inline-flex items-center gap-2 whitespace-nowrap",
                      past || c.health === "ok"
                        ? "text-muted-foreground"
                        : c.health === "down"
                          ? "font-semibold text-fail"
                          : "text-warn",
                    )}
                  >
                    {past ? (
                      <Dot health="unknown" label={`${c.state} at the last check`} />
                    ) : (
                      <Dot health={c.health} label={c.state} />
                    )}
                    {c.state}
                  </span>
                </TableCell>
                {read ? (
                  <>
                    <TableCell className="text-end align-top whitespace-nowrap tabular-nums">
                      {c.uptime ?? ""}
                    </TableCell>
                    <TableCell className="text-end align-top whitespace-normal tabular-nums">
                      {c.jobs && (
                        <>
                          {c.jobs.value}
                          {sources.size > 1 && (
                            <span className="block text-meta text-muted-foreground [overflow-wrap:anywhere]">
                              {c.jobs.from}
                            </span>
                          )}
                        </>
                      )}
                    </TableCell>
                    <TableCell className="align-top whitespace-normal">
                      {c.memory && (
                        <span className="grid min-w-24 gap-1">
                          <span className="tabular-nums">
                            {c.memory.used}
                            {c.memory.limit && <span className="text-muted-foreground"> of {c.memory.limit}</span>}
                          </span>
                          {c.memory.percent !== undefined && (
                            <Progress
                              value={c.memory.percent}
                              tone="muted"
                              aria-label={`Memory ${c.memory.percent}% of its limit`}
                            />
                          )}
                        </span>
                      )}
                    </TableCell>
                  </>
                ) : (
                  <TableCell colSpan={3} className="align-top text-muted-foreground">
                    No figures read
                  </TableCell>
                )}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </>
  )
}

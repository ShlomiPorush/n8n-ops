import { Dot } from "@/components/status"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { byName, type QueueWorkerRow, workerCells, workersFacts, workersSummary } from "@/lib/queue-workers"
import { cn } from "@/lib/utils"

/*
 * The queue workers of an instance on its Health tab. Two lines say once what is the same on all of them (how many
 * are ready, then the jobs they run at once, the n8n they run and the memory limit), and the table keeps what
 * differs between them, one row each, so a worker that stands out is seen down a column. Where something is wrong the
 * row says it under the worker's name. In a narrow pane or on a phone the table stacks, as every table does, each
 * value labelled with its column. `past` shows what the last check read: no tones, and the dots grey.
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
  const facts = workersFacts(sorted, mainVersion)
  // The list was cut (the worker checks at most 50): the facts are of the workers shown.
  const cut = found !== undefined && found > sorted.length
  // Jobs at once are said per row only when they come from different places.
  const sources = new Set(sorted.flatMap((r) => (r.concurrency ? [r.concurrency.from] : [])))
  // Health URLs typed by hand answer health only: without a figure on any row, there are no columns for them.
  const anyRead = sorted.some((r) => r.uptimeSec !== undefined || r.concurrency || r.memory)
  // The main's version not read: a worker's own stands out when they run more than one.
  const mixed = new Set(sorted.flatMap((r) => (r.version ? [r.version] : []))).size > 1

  return (
    <>
      <div className="grid min-w-0 gap-0.5 border-t border-line px-pad-x py-pad-y">
        <p className="font-semibold" data-testid="queue-workers-summary">
          {workersSummary(sorted, { found, past })}
        </p>
        {facts.length > 0 && (
          <p
            className="min-w-0 text-small text-muted-foreground [overflow-wrap:anywhere]"
            data-testid="queue-workers-facts"
          >
            {cut && `The ${sorted.length} shown: `}
            {facts.map((f, i) => (
              <span key={f.text}>
                {i > 0 && " · "}
                <span className={cn(f.warn && !past && "font-medium text-warn")}>{f.text}</span>
              </span>
            ))}
          </p>
        )}
      </div>
      {/* No Sort button (TB-28): the workers stay in name order, worker2 before worker10. */}
      <Table bare>
        <TableHeader>
          <TableRow>
            <TableHead>Worker</TableHead>
            <TableHead>State</TableHead>
            {anyRead && (
              <>
                <TableHead className="text-end">Up for</TableHead>
                <TableHead className="text-end">Jobs at once</TableHead>
                <TableHead>Memory</TableHead>
              </>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((w) => {
            const c = workerCells(w, mainVersion, mixed)
            const read = c.uptime || c.jobs || c.memory
            // A ready worker on another n8n warns too.
            const tint = past
              ? undefined
              : c.health === "down"
                ? "bg-fail/6"
                : c.health === "warn" || c.version
                  ? "bg-warn/6"
                  : undefined
            return (
              <TableRow key={w.url} data-testid="queue-worker" className={tint}>
                <TableCell data-primary className="align-top whitespace-normal">
                  <span className="block font-semibold [overflow-wrap:anywhere]">{w.name ?? w.url}</span>
                  {c.error && (
                    <span
                      className={cn(
                        "block text-small [overflow-wrap:anywhere]",
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
                      n8n {c.version.version}
                      {c.version.main && `, the main runs ${c.version.main}`}
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
                    {/* Stacked, the memory and its bar take a line of their own. */}
                    <TableCell data-wide className="align-top whitespace-normal">
                      {c.memory && (
                        <span className="inline-grid min-w-24 gap-1 align-top">
                          <span className="tabular-nums">
                            <span className="whitespace-nowrap">{c.memory.used}</span>
                            {c.memory.limit && (
                              <span className="whitespace-nowrap text-muted-foreground"> of {c.memory.limit}</span>
                            )}
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
                  anyRead && (
                    <TableCell colSpan={3} className="align-top text-muted-foreground">
                      No figures read
                    </TableCell>
                  )
                )}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </>
  )
}

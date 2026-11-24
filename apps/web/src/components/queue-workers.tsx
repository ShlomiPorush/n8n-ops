import { Dot } from "@/components/status"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { byName, type QueueWorkerRow, workerCells, workersFacts, workersSummary } from "@/lib/queue-workers"
import { cn } from "@/lib/utils"

export function QueueWorkers({
  rows,
  mainVersion,
  found,
  past,
}: {
  rows: QueueWorkerRow[]
  mainVersion?: string
  found?: number
  past: boolean
}) {
  if (rows.length === 0) return null
  const sorted = [...rows].sort(byName)
  const facts = workersFacts(sorted, mainVersion)
  const cut = found !== undefined && found > sorted.length
  const sources = new Set(sorted.flatMap((r) => (r.concurrency ? [r.concurrency.from] : [])))
  const anyRead = sorted.some((r) => r.uptimeSec !== undefined || r.concurrency || r.memory)
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

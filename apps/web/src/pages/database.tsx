import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Database, HardDrive, RefreshCw } from "lucide-react"
import { useEffect, useRef } from "react"
import { useConfirm } from "@/components/confirm"
import { BusyButton, Kpi, Kpis, LoadError, Loading, Panel, PanelHead } from "@/components/kit"
import { When } from "@/components/status"
import { ApiError, api, describeError, readFresh } from "@/lib/api"
import { formatSize } from "@/lib/numbers"
import { toast } from "@/lib/toast"

/*
 * Settings → Database: how much room the n8n-ops database takes, the free space inside each table, and compacting
 * a table (PostgreSQL's VACUUM FULL) to give that space back to the disk. One compaction runs at a time; the page
 * follows it, also one another tab started.
 */

type TableSize = {
  name: string
  totalBytes: number | null
  tableBytes: number | null
  indexBytes: number | null
  compactable: boolean
  compacting: boolean
}
type TableFreeSpace = { free: number; dead: number } | { error: string }
type Report = {
  databaseBytes: number | null
  tables: TableSize[]
  busy: boolean
  freeSpace: { measuredAt: string; unavailable: string | null; tables: Record<string, TableFreeSpace> }
}
type Run = {
  id: string
  tableName: string
  status: "running" | "done" | "failed" | "unknown"
  sizeBefore: number | null
  sizeAfter: number | null
  error: string | null
  startedBy: string
  startedAt: string
  finishedAt: string | null
}
type Status = { running: Run | null; progress: { phase: string; percent: number | null } | null; recent: Run[] }

const REPORT = "/admin/database"
const STATUS = "/admin/database/status"

/** Tables whose wait stops more than n8n-ops' own pages, named in the question. */
const alsoWaiting: Record<string, string> = {
  worker_jobs: "Workers' checks and backups",
}

export function DatabaseSection({ hidden = false }: { hidden?: boolean }) {
  const client = useQueryClient()
  const ask = useConfirm()
  // Measuring reads every table: only on opening, after a compaction and on Measure again, never on focus or retry.
  const report = useQuery<Report>({
    queryKey: [REPORT],
    queryFn: () => readFresh<Report>(REPORT),
    enabled: !hidden,
    refetchOnWindowFocus: false,
    retry: false,
  })
  // Cheap, and answers during a compaction: followed while the section is open, faster while one runs.
  const status = useQuery<Status>({
    queryKey: [STATUS],
    queryFn: () => readFresh<Status>(STATUS),
    enabled: !hidden,
    refetchInterval: (q) => (q.state.data?.running ? 2_000 : 5_000),
  })
  const running = status.data?.running ?? null

  // A compaction that ended since the page last looked, here or in another tab, however short: say how it went
  // and measure again. The newest ended run when the page opens is only remembered.
  const lastEnded = status.data?.recent.find((r) => r.status !== "running") ?? null
  const seen = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (!status.data) return
    const was = seen.current
    seen.current = lastEnded?.id ?? null
    if (was === undefined || !lastEnded || lastEnded.id === was) return
    const ended = lastEnded
    if (ended.status === "done")
      toast.success(
        `${ended.tableName} compacted: ${formatSize(ended.sizeBefore ?? 0)} to ${sizeOrUnknown(ended.sizeAfter)}`,
      )
    else if (ended.status === "failed") toast.error(`${ended.tableName} was not compacted: ${ended.error ?? ""}`)
    else toast.error(`Unknown how compacting ${ended.tableName} ended`)
    void client.invalidateQueries({ queryKey: [REPORT] })
  }, [lastEnded, status.data, client])

  async function measure() {
    try {
      await api(`${REPORT}/measure`, { method: "POST", json: {} })
      await report.refetch()
    } catch (e) {
      toast.error(`Could not measure free space: ${describeError(e)}`)
      throw e
    }
  }

  async function compact(t: TableSize) {
    const also = alsoWaiting[t.name]
    const ok = await ask({
      title: `Compact ${t.name}?`,
      message: (
        <div className="grid gap-2">
          <p>
            PostgreSQL copies the table's data into new files and rebuilds its indexes. While it runs, everything that
            reads or writes {t.name} waits, including pages of n8n-ops that need it{also ? `, and ${also}` : ""}.
          </p>
          <p>
            It needs free disk space on the database host for the new copy. Plan for up to the size of its data and
            indexes today, {sizeOrUnknown(t.totalBytes)}; the copy holds only the rows still in use, so it is usually
            much smaller, and the database log needs room too. n8n-ops cannot check that space. If the disk fills,
            PostgreSQL stops and the table stays as it was.
          </p>
        </div>
      ),
      confirmLabel: "Compact table",
    })
    if (!ok) return
    try {
      await api(`${REPORT}/compact`, { method: "POST", json: { table: t.name } })
      toast.success(`Compacting ${t.name}`)
    } catch (e) {
      toast.error(
        e instanceof ApiError && e.status === 409
          ? "Another table is being compacted. Try again when it ends."
          : `Could not compact ${t.name}: ${describeError(e)}`,
      )
      throw e
    } finally {
      // Whatever the answer, the page reads what runs now (another tab may have started one, or the answer was lost).
      await status.refetch()
    }
  }

  const data = report.data
  const free = data?.freeSpace
  const measured = free && !free.unavailable ? sumFree(free.tables) : null
  const lastOf = (table: string) => status.data?.recent.find((r) => r.tableName === table && r.status !== "running")

  return (
    <Panel hidden={hidden}>
      <PanelHead
        title="Tables"
        action={
          <BusyButton size="sm" icon={RefreshCw} busyLabel="Measuring…" run={measure} disabled={!data}>
            Measure again
          </BusyButton>
        }
      />
      {report.isError && !data ? (
        <LoadError what="the database sizes" error={report.error} retry={() => report.refetch()} />
      ) : !data ? (
        <Loading>Measuring the database…</Loading>
      ) : (
        <>
          <div className="px-pad-x pb-pad-y">
            <Kpis>
              <Kpi icon={Database} label="Database size" value={sizeOrUnknown(data.databaseBytes)} />
              <Kpi
                icon={HardDrive}
                label="Free space in tables"
                value={!measured || measured.tables === 0 ? "Not measured" : formatSize(measured.bytes)}
                hint={measured?.missing ? `${measured.missing} not measured` : undefined}
              />
              <Kpi label="Measured" value={<When value={free?.measuredAt} />} />
            </Kpis>
          </div>
          {data.busy && (
            <p className="border-t border-line px-pad-x py-pad-y text-muted-foreground">
              A table is being compacted. The sizes show when it ends.
            </p>
          )}
          {data.tables.map((t) => {
            const space = free?.tables[t.name]
            const last = lastOf(t.name)
            const mine = running?.tableName === t.name
            return (
              <div
                key={t.name}
                data-testid={`table-${t.name}`}
                className="grid min-w-0 gap-x-4 gap-y-2 border-t border-line px-pad-x py-pad-y md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
              >
                <div className="min-w-0">
                  <span className="font-semibold break-all">{t.name}</span>
                  <div className="mt-1 text-small text-muted-foreground">
                    {t.compacting || mine ? (
                      "Being compacted"
                    ) : (
                      <>
                        {sizeOrUnknown(t.totalBytes)} on disk · {sizeOrUnknown(t.indexBytes)} in indexes
                        {space && "error" in space ? (
                          <> · {space.error}</>
                        ) : space ? (
                          <>
                            {" "}
                            · {formatSize(space.free)} free · {formatSize(space.dead)} in deleted rows
                          </>
                        ) : null}
                      </>
                    )}
                  </div>
                  {last && !mine && <LastRun run={last} />}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {mine ? (
                    <span role="status" className="text-small font-semibold">
                      {status.data?.progress?.phase ?? "Starting"}
                      {status.data?.progress?.percent != null ? ` ${status.data.progress.percent}%` : "…"}
                    </span>
                  ) : t.compactable ? (
                    <BusyButton
                      size="sm"
                      busyLabel="Starting…"
                      disabled={Boolean(running) || t.compacting}
                      run={() => compact(t)}
                    >
                      Compact
                    </BusyButton>
                  ) : t.compacting ? null : (
                    <span className="max-w-[28ch] text-small text-muted-foreground">{excludedReason(t.name)}</span>
                  )}
                </div>
              </div>
            )
          })}
          <p className="border-t border-line px-pad-x py-pad-y text-small text-muted-foreground">
            {free?.unavailable ??
              "Free space is PostgreSQL's estimate (pgstattuple) of the space inside a table's data that it can reuse now; deleted rows are space a vacuum has not cleared yet. Indexes are not measured."}
          </p>
        </>
      )}
    </Panel>
  )
}

function LastRun({ run }: { run: Run }) {
  const when = <When value={run.finishedAt ?? run.startedAt} />
  if (run.status === "done")
    return (
      <div className="mt-1 text-small text-ok">
        Compacted {when} in {took(run)}: {sizeOrUnknown(run.sizeBefore)} to {sizeOrUnknown(run.sizeAfter)}
      </div>
    )
  if (run.status === "unknown")
    return (
      <div className="mt-1 text-small break-words text-warn">
        Unknown, {when}: n8n-ops lost PostgreSQL's answer. The sizes above are measured now.
      </div>
    )
  return (
    <div className="mt-1 text-small break-words text-fail">
      Not compacted, {when}: {run.error}
    </div>
  )
}

/** The free space of the tables that were measured, and how many were not. */
function sumFree(tables: Record<string, TableFreeSpace>) {
  const all = Object.values(tables)
  const ok = all.filter((t): t is { free: number; dead: number } => "free" in t)
  const missing = all.length - ok.length
  return {
    bytes: ok.reduce((sum, t) => sum + t.free, 0),
    tables: ok.length,
    missing: missing ? `${missing} ${missing === 1 ? "table" : "tables"}` : null,
  }
}

function took(run: Run) {
  const ms = run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : 0
  return ms < 1000 ? "under a second" : `${Math.round(ms / 1000)} s`
}

function excludedReason(table: string) {
  return table === "db_compactions"
    ? "n8n-ops records compactions in this table; it cannot be compacted from here."
    : "Every page reads this table; it cannot be compacted from here."
}

function sizeOrUnknown(bytes: number | null) {
  return bytes === null ? "unknown" : formatSize(bytes)
}

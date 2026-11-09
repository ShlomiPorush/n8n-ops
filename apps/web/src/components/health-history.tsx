import { useEffect, useRef, useState } from "react"
import { Empty, LoadError, Loading, Panel, PanelHead } from "@/components/kit"
import { Code, Tone, When } from "@/components/status"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useApi } from "@/lib/api"
import { n, plural } from "@/lib/numbers"
import { formatClock, formatDayMonth, formatTime, useTimeFormat } from "@/lib/time"
import { cn } from "@/lib/utils"

/**
 * The Health tab's history of the main: response times over a range, with failed checks marked, and the runs of
 * failed checks in a row with what each one means. The same answer agents read from /api/v1/health.
 */

type Bucket = {
  at: string
  checks: number
  failed: number
  notCollected: number
  measured: number
  minMs: number | null
  avgMs: number | null
  maxMs: number | null
}

type Run = {
  startedAt: string
  startTruncated: boolean
  lastFailureAt: string
  recoverySeenAt: string | null
  recoverySeen: boolean
  checks: number
  checksAtLeast: boolean
  kinds: string[]
  alertQueued: boolean | null
  lastFailure: {
    kind: string | null
    status: number | null
    code: string | null
    error: string | null
    hint: string
  } | null
}

type History = {
  window: { from: string; to: string; bucketMinutes: number }
  historyStartsAt: string | null
  summary: {
    checks: number
    failed: number
    notCollected: number
    measured: number
    p50Ms: number | null
    p95Ms: number | null
    maxMs: number | null
    runs: number
  }
  series: Bucket[]
  runs: Run[]
  total: number
}

const RANGES = [
  { value: "24", label: "24 h" },
  { value: "168", label: "7 d" },
  { value: "720", label: "30 d" },
]

const KIND: Record<string, string> = {
  timeout: "No answer in time",
  refused: "Connection refused",
  network: "Network error",
  container: "Container stopped",
  http: "Error status",
  other: "Failed",
}

const ms = (v: number | null) => (v === null ? "-" : `${n(Math.round(v))} ms`)

/** Reads only while its tab is shown: the pane keeps every tab mounted. */
export function HealthHistory({ instanceId, active }: { instanceId: string; active: boolean }) {
  const [hours, setHours] = useState("24")
  const history = useApi<History>(active ? `/instances/${instanceId}/health-history?hours=${hours}&limit=20` : null, {
    refetchInterval: 60_000,
    keepRows: true,
  })
  const h = history.data
  const s = h?.summary
  return (
    <>
      <Panel>
        <PanelHead
          title="Response times"
          action={
            <ToggleGroup
              type="single"
              segmented
              aria-label="Range"
              value={hours}
              onValueChange={(v) => v && setHours(v)}
            >
              {RANGES.map((r) => (
                <ToggleGroupItem key={r.value} value={r.value}>
                  {r.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          }
          description={
            s && s.checks + s.notCollected > 0 ? (
              <>
                {s.measured > 0
                  ? `Median ${ms(s.p50Ms)}, 95% under ${ms(s.p95Ms)}, slowest ${ms(s.maxMs)}. `
                  : "No response time was measured: the worker on this host sends them from its next release on. "}
                {s.failed > 0
                  ? `${plural(s.failed, "failed check")} of ${n(s.checks)}.`
                  : `All ${plural(s.checks, "check")} passed.`}
                {s.notCollected > 0 && ` ${plural(s.notCollected, "check")} could not be made.`}
              </>
            ) : undefined
          }
        />
        {history.error && !h ? (
          <LoadError what="the health history" error={history.error} retry={() => history.refetch()} />
        ) : !h ? (
          <Loading />
        ) : h.series.length === 0 ? (
          <Empty title="No checks in this range yet">Each health check is kept here from now on.</Empty>
        ) : (
          <Chart history={h} />
        )}
      </Panel>
      {h && h.total > 0 && (
        <Panel>
          <PanelHead
            title="Failed checks in a row"
            count={n(h.total)}
            description={
              h.total > h.runs.length
                ? `The ${h.runs.length} latest; agents can read all of them.`
                : "A run ends at the next check that passes; a check that could not be made does not end it."
            }
          />
          {h.runs.map((r) => (
            <RunRow key={r.startedAt} run={r} />
          ))}
        </Panel>
      )}
    </>
  )
}

function RunRow({ run }: { run: Run }) {
  const f = run.lastFailure
  const kinds = run.kinds.map((k) => KIND[k] ?? k)
  return (
    <div className="flex min-w-0 flex-col gap-1 border-t border-line px-pad-x py-pad-y">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="font-title">
          <When value={run.startedAt} />
        </span>
        <Tone tone="fail">{kinds.join(", ") || "Failed"}</Tone>
        <span className="text-muted-foreground tabular-nums">
          {run.checksAtLeast ? "at least " : ""}
          {plural(run.checks, "check")}
        </span>
        {run.alertQueued === true && <Tone tone="warn">Down alert sent</Tone>}
        <span className="ms-auto text-end text-muted-foreground">
          {run.recoverySeenAt ? (
            <>
              passed again <When value={run.recoverySeenAt} />
            </>
          ) : (
            "no passing check seen since"
          )}
        </span>
      </div>
      {f && (
        <p className="text-small text-muted-foreground">
          {f.error && <Code>{f.error}</Code>} {f.hint}
          {run.startTruncated && " The history kept starts inside this run, so it may have begun earlier."}
        </p>
      )}
    </div>
  )
}

const HEIGHT = 180
const PAD = { top: 12, right: 12, bottom: 26, left: 52 }

/** A round top for the time axis: the largest time shown, rounded up to 1, 2 or 5 times a power of ten. */
function niceMax(v: number) {
  const top = Math.max(v, 50)
  const p = 10 ** Math.floor(Math.log10(top))
  return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= top) ?? top
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry?.contentRect.width ?? 0)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

function Chart({ history }: { history: History }) {
  const w = useTimeFormat()
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const from = new Date(history.window.from).getTime()
  const to = new Date(history.window.to).getTime()
  const span = Math.max(to - from, 1)
  const plotW = Math.max(width - PAD.left - PAD.right, 1)
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const top = niceMax(Math.max(0, ...history.series.map((b) => b.maxMs ?? 0)))
  const bucketMs = history.window.bucketMinutes * 60_000
  const x = (t: number) => PAD.left + ((t - from) / span) * plotW
  const y = (v: number) => PAD.top + plotH - (Math.min(v, top) / top) * plotH
  const mid = (b: Bucket) => new Date(b.at).getTime() + bucketMs / 2

  // A line breaks where a bucket has no measured time, so a gap is never drawn as if it were known.
  const segments: Bucket[][] = []
  let current: Bucket[] = []
  for (const b of history.series) {
    if (b.avgMs === null) {
      if (current.length) segments.push(current)
      current = []
    } else current.push(b)
  }
  if (current.length) segments.push(current)
  const line = (seg: Bucket[]) =>
    seg.map((b, i) => `${i ? "L" : "M"}${x(mid(b)).toFixed(1)},${y(b.avgMs ?? 0).toFixed(1)}`).join("")
  const band = (seg: Bucket[]) =>
    `${seg.map((b, i) => `${i ? "L" : "M"}${x(mid(b)).toFixed(1)},${y(b.maxMs ?? 0).toFixed(1)}`).join("")}${[...seg]
      .reverse()
      .map((b) => `L${x(mid(b)).toFixed(1)},${y(b.minMs ?? 0).toFixed(1)}`)
      .join("")}Z`
  const tick = (t: number) => (span > 2 * 86_400_000 ? formatDayMonth(t, w) : formatClock(t, w, { seconds: false }))
  const hovered = hover === null ? undefined : history.series[hover]

  const pick = (clientX: number, rect: DOMRect) => {
    const t = from + ((clientX - rect.left - PAD.left) / plotW) * span
    let best = 0
    history.series.forEach((b, i) => {
      if (Math.abs(mid(b) - t) < Math.abs(mid(history.series[best] ?? b) - t)) best = i
    })
    setHover(best)
  }

  return (
    <div ref={ref} className="relative border-t border-line px-0 pt-2 pb-1" data-testid="health-chart">
      {width > 0 && (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`Response time of /healthz from ${tick(from)} to ${tick(to)}, with failed checks marked`}
          className="block touch-pan-y select-none"
          onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerLeave={() => setHover(null)}
        >
          {[0, top / 2, top].map((v) => (
            <g key={v} className="text-line">
              <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} stroke="currentColor" strokeWidth={1} />
              <text
                x={PAD.left - 8}
                y={y(v)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted-foreground text-meta tabular-nums"
              >
                {v === 0 ? "0" : `${n(v)} ms`}
              </text>
            </g>
          ))}
          {[from, from + span / 2, to].map((t, i) => (
            <text
              key={t}
              x={x(t)}
              y={HEIGHT - 6}
              textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
              className="fill-muted-foreground text-meta tabular-nums"
            >
              {tick(t)}
            </text>
          ))}
          <g className="text-ink">
            {segments.map((seg) => (
              <path key={`band-${seg[0]?.at}`} d={band(seg)} fill="currentColor" opacity={0.12} />
            ))}
            {segments.map((seg) =>
              seg.length === 1 ? (
                <circle
                  key={`dot-${seg[0]?.at}`}
                  cx={x(mid(seg[0] as Bucket))}
                  cy={y(seg[0]?.avgMs ?? 0)}
                  r={2.5}
                  fill="currentColor"
                />
              ) : (
                <path
                  key={`line-${seg[0]?.at}`}
                  d={line(seg)}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ),
            )}
          </g>
          {/* Failed checks sit on the baseline in the failure colour, each with a ring of the surface. */}
          <g className="text-fail">
            {history.series
              .filter((b) => b.failed > 0)
              .map((b) => (
                <circle
                  key={`fail-${b.at}`}
                  cx={x(mid(b))}
                  cy={y(0)}
                  r={4}
                  fill="currentColor"
                  className="stroke-panel"
                  strokeWidth={2}
                />
              ))}
          </g>
          {hovered && (
            <line
              x1={x(mid(hovered))}
              x2={x(mid(hovered))}
              y1={PAD.top}
              y2={PAD.top + plotH}
              className="stroke-muted-foreground"
              strokeWidth={1}
            />
          )}
        </svg>
      )}
      {hovered && (
        <div
          className={cn(
            "pointer-events-none absolute top-2 z-10 rounded-sm bg-popover px-2.5 py-1.5 text-small shadow-float ring-1 ring-ink/10",
            x(mid(hovered)) > width / 2 ? "-translate-x-full" : "",
          )}
          style={{ left: x(mid(hovered)) + (x(mid(hovered)) > width / 2 ? -10 : 10) }}
        >
          <div className="text-muted-foreground">{formatTime(hovered.at, w, { seconds: false })}</div>
          {hovered.avgMs !== null ? (
            <div>
              <span className="font-title tabular-nums">{ms(hovered.avgMs)}</span>{" "}
              <span className="text-muted-foreground">
                average, {ms(hovered.minMs)} to {ms(hovered.maxMs)}
              </span>
            </div>
          ) : (
            <div className="text-muted-foreground">No measured time</div>
          )}
          {hovered.failed > 0 && (
            <div className="font-semibold text-fail tabular-nums">{plural(hovered.failed, "failed check")}</div>
          )}
          {hovered.notCollected > 0 && (
            <div className="text-muted-foreground">{plural(hovered.notCollected, "check")} could not be made</div>
          )}
        </div>
      )}
    </div>
  )
}

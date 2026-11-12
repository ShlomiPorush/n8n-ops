import { useId, useState } from "react"
import { ChartTip, chartTick, msText, niceMax, RangeToggle, TimeTicks, useWidth } from "@/components/history-chart"
import { Command, Empty, Kpi, Kpis, LoadError, Loading, RefreshLine } from "@/components/kit"
import { Code, TimeAgo, Tone, When } from "@/components/status"
import { Button } from "@/components/ui/button"
import { useApi } from "@/lib/api"
import { n, plural } from "@/lib/numbers"
import { formatTime, useTimeFormat } from "@/lib/time"
import { cn } from "@/lib/utils"
import {
  bucketLines,
  chartLabel,
  describeHealth,
  dockerHint,
  dockerParts,
  durationText,
  type WorkerHealth as Health,
  jobText,
  needsUpdate,
  percentText,
  rangeText,
  rttRuns,
  stripParts,
  unmeasured,
  type WorkerBucket,
  type WorkerEvent,
} from "@/lib/worker-health"

/**
 * A Worker's health over a range, under its Health toggle on the Workers page: whether it was reachable, how fast its
 * calls to n8n-ops were, whether it reached Docker and when it restarted, with the events of the range. The same
 * answer agents read from /api/v1/worker-health.
 */

/** Events shown at first, and added by each Show more; the server gives at most RUNS_MAX at once. */
const PAGE = 20
const EVENTS_MAX = 500

/** A surface inside the Worker's card: outlined in Compact, a tinted block in Regular. */
const box = "grid min-w-0 gap-3 rounded-lg border border-line p-3 regular:border-0 regular:bg-fill regular:p-4"

export function WorkerHealth({ workerId }: { workerId: string }) {
  const [hours, setHours] = useState("24")
  const [limit, setLimit] = useState(PAGE)
  // A growing first page rather than pages by offset: the window moves with every refresh, so pages would not meet.
  const health = useApi<Health>(`/workers/${workerId}/health?hours=${hours}&limit=${limit}`, {
    refetchInterval: 60_000,
    keepRows: true,
  })
  const h = health.data
  return (
    <div className="grid min-w-0 gap-3" data-testid={`worker-health-${workerId}`}>
      <section className={box} aria-labelledby={`${workerId}-health`}>
        {/* A refresh, or another range, that failed: says so with Try again, over the data kept on screen. */}
        <RefreshLine live={health} what="this range" />
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
          <h3 id={`${workerId}-health`} className="text-head">
            Health
          </h3>
          <div className="ms-auto">
            <RangeToggle
              value={hours}
              onChange={(v) => {
                setHours(v)
                setLimit(PAGE)
              }}
            />
          </div>
        </div>
        {health.error && !h ? (
          <LoadError what="the Worker's health" error={health.error} retry={() => health.refetch()} />
        ) : !h ? (
          <Loading />
        ) : h.historyStartsAt === null ? (
          <Empty title="No history yet.">Each call of the Worker is kept from now on.</Empty>
        ) : (
          <>
            <p className="text-small text-muted-foreground regular:text-body" data-testid="worker-health-description">
              {describeHealth(h, Number(hours))}
              {h.summary.notMeasuredMs > 0 && (
                <>
                  {" "}
                  Kept since <When value={h.historyStartsAt} />.
                </>
              )}
            </p>
            <Figures health={h} />
            <Chart health={h} range={rangeText(Number(hours))} />
            {needsUpdate(h) && <UpdateAdvice update={h.worker.update} stored={!unmeasured(h)} />}
          </>
        )}
      </section>
      {h && h.historyStartsAt !== null && (
        <Events
          health={h}
          more={
            h.nextOffset !== null && limit < EVENTS_MAX ? () => setLimit((l) => Math.min(l + PAGE, EVENTS_MAX)) : null
          }
          busy={health.isFetching === true}
        />
      )}
    </div>
  )
}

function Figures({ health: h }: { health: Health }) {
  const s = h.summary
  const available = (
    <Kpi
      label="Available"
      value={percentText(s.availability)}
      hint={
        <>
          {s.offlinePeriods > 0
            ? `${plural(s.offlinePeriods, "offline period")}, ${durationText(s.offlineMs)}`
            : "No offline period"}
          {s.notRecordingMs > 0 && `; n8n-ops not recording ${durationText(s.notRecordingMs)}`}
        </>
      }
    />
  )
  if (unmeasured(h))
    return (
      <Kpis className="md:grid-cols-4 compact:md:grid-cols-4 max-md:*:col-span-full md:[&>:last-child]:col-span-3">
        {available}
        <Kpi
          label="Round trip, Docker, restarts"
          value="Not measured"
          hint={
            h.worker.version
              ? `This Worker runs ${h.worker.version}, which does not report them.`
              : "This Worker does not report them."
          }
        />
      </Kpis>
    )
  const lastRestart = h.periods.restarts.at(-1)
  const d = h.docker
  return (
    <Kpis className="md:grid-cols-2 compact:md:grid-cols-2 lg:grid-cols-4 compact:lg:grid-cols-4">
      {available}
      <Kpi
        label="Round trip"
        value={s.rttAvgMs === null ? "None" : msText(s.rttAvgMs)}
        hint={
          <>
            {s.rttAvgMs === null
              ? "No round-trip measurements in this range"
              : `average, slowest ${msText(s.rttMaxMs)}`}
            {s.failedCalls > 0 && ` · ${plural(s.failedCalls, "call")} failed`}
          </>
        }
      />
      <Kpi
        label="Restarts"
        value={s.restarts}
        hint={
          lastRestart ? (
            <>
              last <When value={lastRestart} />
            </>
          ) : (
            "None in this range"
          )
        }
      />
      <Kpi
        label="Docker"
        value={d?.current ? (d.ok ? "OK" : "Failing") : "Not checked"}
        tone={d?.current && !d.ok ? "fail" : undefined}
        hint={
          <>
            {dockerHint(h)}
            {d ? (
              <>
                , checked <TimeAgo value={d.checkedAt} />
              </>
            ) : (
              ", no check seen"
            )}
          </>
        }
      />
    </Kpis>
  )
}

/** The update a Worker without heartbeats needs; `stored` when the range still shows what it measured before. */
function UpdateAdvice({ update, stored }: { update: string | null; stored: boolean }) {
  return (
    <div className="grid min-w-0 gap-1.5 rounded-sm bg-bg p-3 regular:bg-panel">
      <p>
        <b className="font-title">Update this Worker</b>{" "}
        {stored
          ? "to measure round trip, Docker and restarts again; this range shows only what it measured before."
          : "to see round trip, Docker and restarts."}
        {update && " Its image line in docker-compose.yml:"}
      </p>
      {update && <Command value={update} label="Copy the image line" />}
    </div>
  )
}

const PAD = { top: 8, right: 12, bottom: 22, left: 52 }
const STRIP_H = 22
/** Docker failing marks sit under the strip, the round-trip chart under them. */
const MARK_Y = PAD.top + STRIP_H + 3
const RTT_TOP = PAD.top + STRIP_H + 20
const RTT_H = 120

const STRIP_FILL: Record<string, string> = {
  online: "fill-ok/35",
  offline: "fill-fail",
  "not-measured": "fill-line",
}

function Chart({ health: h, range }: { health: Health; range: string }) {
  const w = useTimeFormat()
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const hatch = `hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const from = new Date(h.window.from).getTime()
  const to = new Date(h.window.to).getTime()
  const span = Math.max(to - from, 1)
  const runs = rttRuns(h.series)
  const rtt = runs.length > 0
  const measured = !unmeasured(h)
  const height = rtt ? RTT_TOP + RTT_H + PAD.bottom : PAD.top + STRIP_H + 12 + PAD.bottom
  const plotW = Math.max(width - PAD.left - PAD.right, 1)
  const bucketMs = h.window.bucketMinutes * 60_000
  const x = (t: number) => PAD.left + ((Math.min(Math.max(t, from), to) - from) / span) * plotW
  const top = niceMax(Math.max(0, ...h.series.map((b) => b.rttMaxMs ?? 0)))
  const base = RTT_TOP + RTT_H
  const y = (v: number) => base - (Math.min(v, top) / top) * RTT_H
  const mid = (b: WorkerBucket) => new Date(b.at).getTime() + bucketMs / 2
  // A period of a few minutes in 30 days is under a pixel wide: it is drawn at least 2 pixels wide, so it shows.
  const wide = (a: number, b: number) => Math.max(2, x(b) - x(a))
  const hovered = hover === null ? undefined : h.series[hover]
  const pick = (clientX: number, rect: DOMRect) => {
    const t = from + ((clientX - rect.left - PAD.left) / plotW) * span
    let best = 0
    h.series.forEach((b, i) => {
      if (Math.abs(mid(b) - t) < Math.abs(mid(h.series[best] ?? b) - t)) best = i
    })
    setHover(h.series.length ? best : null)
  }
  const area = (run: WorkerBucket[]) =>
    `M${x(mid(run[0] as WorkerBucket)).toFixed(1)},${base}${run
      .map((b) => `L${x(mid(b)).toFixed(1)},${y(b.rttMaxMs ?? b.rttAvgMs ?? 0).toFixed(1)}`)
      .join("")}L${x(mid(run.at(-1) as WorkerBucket)).toFixed(1)},${base}Z`
  const line = (run: WorkerBucket[]) =>
    run.map((b, i) => `${i ? "L" : "M"}${x(mid(b)).toFixed(1)},${y(b.rttAvgMs ?? 0).toFixed(1)}`).join("")
  const restarts = h.periods.restarts.map((r) => new Date(r).getTime())

  return (
    <div className="min-w-0 rounded-sm bg-bg py-2 regular:bg-panel">
      <div ref={ref} className="relative" data-testid="worker-health-chart">
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={chartLabel(h, `${range}, ${chartTick(from, span, w)} to ${chartTick(to, span, w)}`)}
            className="block touch-pan-y select-none"
            onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
            onPointerLeave={() => setHover(null)}
          >
            <defs>
              <pattern id={hatch} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width={6} height={6} className="fill-fill" />
                <line x1={0} y1={0} x2={0} y2={6} className="stroke-muted-foreground" strokeWidth={2.5} />
              </pattern>
            </defs>
            <text
              x={PAD.left - 8}
              y={PAD.top + STRIP_H / 2}
              dy="0.32em"
              textAnchor="end"
              className="fill-muted-foreground text-meta"
            >
              Reach
            </text>
            {stripParts(h).map((p) => (
              <rect
                key={`${p.kind}-${p.from}`}
                x={x(p.from)}
                y={PAD.top}
                width={p.kind === "online" || p.kind === "not-measured" ? x(p.to) - x(p.from) : wide(p.from, p.to)}
                height={STRIP_H}
                className={p.kind === "not-recording" ? undefined : STRIP_FILL[p.kind]}
                fill={p.kind === "not-recording" ? `url(#${hatch})` : undefined}
              />
            ))}
            <g className="text-warn">
              {dockerParts(h).map((p) => (
                <rect
                  key={`docker-${p.from}`}
                  x={x(p.from) - 1}
                  y={MARK_Y}
                  width={Math.max(5, x(p.to) - x(p.from) + 2)}
                  height={5}
                  rx={2}
                  fill="currentColor"
                />
              ))}
            </g>
            {rtt && (
              <>
                {[0, top / 2, top].map((v) => (
                  <g key={v} className="text-line">
                    <line
                      x1={PAD.left}
                      x2={width - PAD.right}
                      y1={y(v)}
                      y2={y(v)}
                      stroke="currentColor"
                      strokeWidth={1}
                    />
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
                <g className="text-ink">
                  {runs.map((run) => (
                    <path key={`max-${run[0]?.at}`} d={area(run)} fill="currentColor" opacity={0.12} />
                  ))}
                  {runs.map((run) =>
                    run.length === 1 ? (
                      <circle
                        key={`dot-${run[0]?.at}`}
                        cx={x(mid(run[0] as WorkerBucket))}
                        cy={y(run[0]?.rttAvgMs ?? 0)}
                        r={2.5}
                        fill="currentColor"
                      />
                    ) : (
                      <path
                        key={`avg-${run[0]?.at}`}
                        d={line(run)}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.75}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    ),
                  )}
                </g>
              </>
            )}
            {/* A restart: a line through the strip with a dot on top, dashed on down through the round trip. */}
            <g className="text-info">
              {restarts.map((t) => (
                <g key={`restart-${t}`}>
                  <line
                    x1={x(t)}
                    x2={x(t)}
                    y1={PAD.top - 4}
                    y2={PAD.top + STRIP_H + 4}
                    stroke="currentColor"
                    strokeWidth={2}
                  />
                  <circle cx={x(t)} cy={PAD.top - 3} r={3} fill="currentColor" />
                  {rtt && (
                    <line
                      x1={x(t)}
                      x2={x(t)}
                      y1={RTT_TOP}
                      y2={base}
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                    />
                  )}
                </g>
              ))}
            </g>
            <TimeTicks from={from} to={to} x={x} y={height - 6} w={w} />
            {hovered && (
              <line
                x1={x(mid(hovered))}
                x2={x(mid(hovered))}
                y1={PAD.top}
                y2={rtt ? base : PAD.top + STRIP_H}
                className="stroke-muted-foreground"
                strokeWidth={1}
              />
            )}
          </svg>
        )}
        {hovered && (
          <ChartTip at={x(mid(hovered))} width={width}>
            <div className="text-muted-foreground">{formatTime(hovered.at, w, { seconds: false })}</div>
            {bucketLines(hovered, bucketMs).map((l) => (
              <div
                key={l.text}
                className={cn(l.tone === "fail" && "font-semibold text-fail", l.tone === "warn" && "text-warn")}
              >
                {l.text}
              </div>
            ))}
          </ChartTip>
        )}
      </div>
      {width > 0 && <Legend hatch={hatch} rtt={rtt} measured={measured} notMeasured={h.summary.notMeasuredMs > 0} />}
    </div>
  )
}

function Legend({
  hatch,
  rtt,
  measured,
  notMeasured,
}: {
  hatch: string
  rtt: boolean
  measured: boolean
  notMeasured: boolean
}) {
  const swatch = (child: React.ReactNode) => (
    <svg width={14} height={10} aria-hidden className="shrink-0">
      {child}
    </svg>
  )
  const items: [string, React.ReactNode][] = [
    ["Online", swatch(<rect width={14} height={10} rx={2} className="fill-ok/35" />)],
    ["Worker offline", swatch(<rect width={14} height={10} rx={2} className="fill-fail" />)],
    ["n8n-ops not recording", swatch(<rect width={14} height={10} rx={2} fill={`url(#${hatch})`} />)],
  ]
  if (notMeasured) items.push(["Not measured", swatch(<rect width={14} height={10} rx={2} className="fill-line" />)])
  if (rtt) {
    items.push(["Round trip, average", swatch(<rect y={4} width={14} height={2} className="fill-ink" />)])
    items.push(["slowest", swatch(<rect width={14} height={10} rx={2} className="fill-ink/12" />)])
  }
  if (measured) {
    items.push(["Restart", swatch(<rect x={6} width={2} height={10} className="fill-info" />)])
    items.push(["Docker failing", swatch(<rect y={3} width={14} height={5} rx={2} className="fill-warn" />)])
  }
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 px-3 pt-1 text-meta text-muted-foreground md:ps-13" aria-hidden>
      {items.map(([label, mark]) => (
        <li key={label} className="inline-flex items-center gap-1.5">
          {mark}
          {label}
        </li>
      ))}
    </ul>
  )
}

function Events({ health: h, more, busy }: { health: Health; more: (() => void) | null; busy: boolean }) {
  const capped = h.nextOffset !== null && !more
  return (
    <section className={box} aria-labelledby={`${h.worker.id}-events`} data-testid="worker-health-events">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h3 id={`${h.worker.id}-events`} className="text-head">
          Events
        </h3>
        <span className="font-medium text-muted-foreground">{n(h.total)}</span>
        <span className="text-small text-muted-foreground">
          {capped
            ? `The ${n(h.events.length)} latest; agents can read all of them.`
            : "Newest first. Agents read the same list."}
        </span>
      </div>
      {h.events.length === 0 ? (
        <p className="text-muted-foreground">No events in this range.</p>
      ) : (
        <div className="grid min-w-0">
          {h.events.map((e) => (
            <EventRow key={`${e.kind}-${e.kind === "restart" ? e.at : e.from}`} event={e} />
          ))}
        </div>
      )}
      {more && (
        <div>
          <Button size="sm" onClick={more} disabled={busy}>
            {busy ? "Loading…" : "Show more"}
          </Button>
        </div>
      )}
    </section>
  )
}

function EventRow({ event: e }: { event: WorkerEvent }) {
  let head: React.ReactNode
  let note: React.ReactNode = null
  if (e.kind === "restart") {
    head = (
      <>
        <span className="font-title">
          <When value={e.at} />
        </span>
        <Tone tone="info">Restart</Tone>
        <span className="text-muted-foreground">
          {e.uptimeSecBefore === null
            ? "the Worker started again"
            : `the Worker started again, after running at least ${durationText(e.uptimeSecBefore * 1000)}`}
        </span>
      </>
    )
  } else if (e.kind === "docker") {
    head = (
      <>
        <span className="font-title">
          <When value={e.from} />
        </span>
        <Tone tone="warn">Docker failing</Tone>
        <span className="text-muted-foreground">
          {durationText(e.durationMs)}
          {e.to === null ? (
            ", still failing"
          ) : e.endUnknown ? (
            ", no check since"
          ) : (
            <>
              , ok again <When value={e.to} />
            </>
          )}
        </span>
      </>
    )
    note = (
      <>
        {e.error ? (
          <>
            The Worker could not reach Docker: <Code>{e.error}</Code>.
          </>
        ) : (
          "The Worker could not reach Docker."
        )}{" "}
        Backups and checks inside the containers fail while this lasts.
        {e.endUnknown && " No check followed within 3 minutes, so when it ended is not known."}
      </>
    )
  } else if (e.kind === "not-recording") {
    head = (
      <>
        <span className="font-title">
          <When value={e.from} />
        </span>
        <Tone tone="muted">n8n-ops not recording</Tone>
        <span className="text-muted-foreground">
          {durationText(e.durationMs)}
          {e.to === null ? (
            ", still going on"
          ) : (
            <>
              , until <When value={e.to} />
            </>
          )}
        </span>
      </>
    )
    note =
      "n8n-ops itself was not running or could not record, for example while it was updated. Not counted against the Worker."
  } else {
    head = (
      <>
        <span className="font-title">
          <When value={e.from} />
        </span>
        <Tone tone="fail">Offline</Tone>
        <span className="text-muted-foreground">
          {durationText(e.durationMs)}
          {e.to === null ? (
            ", still offline"
          ) : (
            <>
              , back <When value={e.to} />
            </>
          )}
        </span>
      </>
    )
    note = (
      <>
        No call from the Worker for 90 s.
        {e.job && (
          <>
            {" "}
            A job was running then: {jobText(e.job)}, started <When value={e.job.startedAt} />.
          </>
        )}
        {e.notRecordingMs > 0 &&
          ` n8n-ops was not recording for ${durationText(e.notRecordingMs)} of it, which is not counted.`}
      </>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-1 border-t border-line py-pad-y first:border-t-0 first:pt-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">{head}</div>
      {note && <p className="text-small text-muted-foreground">{note}</p>}
    </div>
  )
}

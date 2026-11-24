import { useEffect, useRef, useState } from "react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { n } from "@/lib/numbers"
import { type DateWriting, formatClock, formatDayMonth } from "@/lib/time"
import { cn } from "@/lib/utils"

export const HISTORY_RANGES = [
  { value: "24", label: "24 h" },
  { value: "168", label: "7 d" },
  { value: "720", label: "30 d" },
]

export function RangeToggle({ value, onChange }: { value: string; onChange: (hours: string) => void }) {
  return (
    <ToggleGroup type="single" segmented aria-label="Range" value={value} onValueChange={(v) => v && onChange(v)}>
      {HISTORY_RANGES.map((r) => (
        <ToggleGroupItem key={r.value} value={r.value}>
          {r.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

export const msText = (v: number | null) => (v === null ? "-" : `${n(Math.round(v))} ms`)

export function niceMax(v: number) {
  const top = Math.max(v, 50)
  const p = 10 ** Math.floor(Math.log10(top))
  return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= top) ?? top
}

export function useWidth() {
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

export function chartTick(t: number, span: number, w: DateWriting) {
  return span > 2 * 86_400_000 ? formatDayMonth(t, w) : formatClock(t, w, { seconds: false })
}

export function TimeTicks({
  from,
  to,
  x,
  y,
  w,
}: {
  from: number
  to: number
  x: (t: number) => number
  y: number
  w: DateWriting
}) {
  const span = Math.max(to - from, 1)
  return (
    <>
      {[from, from + span / 2, to].map((t, i) => (
        <text
          key={t}
          x={x(t)}
          y={y}
          textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
          className="fill-muted-foreground text-meta"
        >
          {chartTick(t, span, w)}
        </text>
      ))}
    </>
  )
}

export function ChartTip({ at, width, children }: { at: number; width: number; children: React.ReactNode }) {
  const left = at > width / 2
  return (
    <div
      className={cn(
        "pointer-events-none absolute top-2 z-10 w-max max-w-[min(18rem,calc(100%-1rem))] rounded-sm bg-popover px-2.5 py-1.5 text-small shadow-float ring-1 ring-ink/10",
        left ? "-translate-x-full" : "",
      )}
      style={{ left: at + (left ? -10 : 10) }}
    >
      {children}
    </div>
  )
}

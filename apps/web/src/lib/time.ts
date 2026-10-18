import { useQuery } from "@tanstack/react-query"
import { readFresh } from "./api"

/**
 * The time zone set in Settings → General, used for every time on screen so the console, reports and
 * schedules agree. The server falls back to UTC when it is empty, and so does the UI.
 */
export function useTimeZone(): string {
  const general = useQuery({
    queryKey: ["/settings/general"],
    queryFn: () => readFresh<{ timezone?: string }>("/settings/general"),
    staleTime: 5 * 60_000,
  })
  return validZone(general.data?.timezone)
}

const valid = new Map<string, boolean>()
function validZone(zone: string | undefined): string {
  if (!zone) return "UTC"
  if (!valid.has(zone)) {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: zone })
      valid.set(zone, true)
    } catch {
      valid.set(zone, false)
    }
  }
  return valid.get(zone) ? zone : "UTC"
}

const formats = new Map<string, Intl.DateTimeFormat>()
function format(zone: string, options: Intl.DateTimeFormatOptions) {
  const key = `${zone}|${JSON.stringify(options)}`
  let f = formats.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: zone, hourCycle: "h23" })
    formats.set(key, f)
  }
  return f
}

const dayKey = (d: Date, zone: string) => format(zone, { year: "numeric", month: "2-digit", day: "2-digit" }).format(d)

/** For lists: "14:05" today, "12 Oct" earlier this year, "12 Oct 2025" before that. */
export function formatWhen(value: string | Date, zone: string): string {
  const d = new Date(value)
  const now = new Date()
  if (dayKey(d, zone) === dayKey(now, zone)) return format(zone, { hour: "2-digit", minute: "2-digit" }).format(d)
  const sameYear = format(zone, { year: "numeric" }).format(d) === format(zone, { year: "numeric" }).format(now)
  return format(
    zone,
    sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" },
  ).format(d)
}

/** "15 Oct 2026, 14:05:09" in the app's time zone. */
export function formatFull(value: string | Date, zone: string): string {
  return format(zone, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value))
}

/** "15 Oct, 14:05" in the app's time zone, for deadlines and schedules in sentences. */
export function formatDateTime(value: string | Date, zone: string): string {
  return format(zone, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value))
}

/** Thousands separators on every count. */
export function n(value: number | null | undefined): string {
  return (value ?? 0).toLocaleString("en-US")
}

/**
 * A count with its word, singular or plural, with thousands separators (FW-3): "1 problem", "1,920 events".
 * Every count on screen goes through here so a caption, its confirm and its toast never disagree.
 */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${n(count)} ${count === 1 ? one : many}`
}

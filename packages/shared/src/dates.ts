export const dateFormats = ["browser", "DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD", "DD.MM.YYYY"] as const
export type DateFormat = (typeof dateFormats)[number]
export const timeFormats = ["24h", "12h", "browser"] as const
export type TimeFormat = (typeof timeFormats)[number]

export const dateFormatLabels: Record<DateFormat, string> = {
  browser: "Browser",
  "DD/MM/YYYY": "DD/MM/YYYY",
  "MM/DD/YYYY": "MM/DD/YYYY",
  "YYYY-MM-DD": "YYYY-MM-DD",
  "DD.MM.YYYY": "DD.MM.YYYY",
}
export const timeFormatLabels: Record<TimeFormat, string> = { "24h": "24-hour", "12h": "12-hour", browser: "Browser" }

export const isDateFormat = (value: unknown): value is DateFormat => dateFormats.includes(value as DateFormat)
export const isTimeFormat = (value: unknown): value is TimeFormat => timeFormats.includes(value as TimeFormat)

export type DateWriting = { zone: string; date: DateFormat; time: TimeFormat; locale?: string }

type General = { timezone?: string; dateFormat?: string; timeFormat?: string }

export function writingOf(general: General | undefined, locale?: string): DateWriting {
  const date = general?.dateFormat
  const time = general?.timeFormat
  return {
    zone: usableZone(general?.timezone),
    date: isDateFormat(date) ? date : "browser",
    time: isTimeFormat(time) ? time : "24h",
    ...(locale ? { locale } : {}),
  }
}

export function messageWriting(general: General | undefined): DateWriting {
  const w = writingOf(general)
  return {
    zone: w.zone,
    date: w.date === "browser" ? "DD/MM/YYYY" : w.date,
    time: w.time === "browser" ? "24h" : w.time,
  }
}

const formats = new Map<string, Intl.DateTimeFormat>()
function intl(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ""}|${JSON.stringify(options)}`
  let f = formats.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options)
    formats.set(key, f)
  }
  return f
}

const zones = new Map<string, boolean>()
export function usableZone(zone: string | undefined): string {
  if (!zone) return "UTC"
  if (!zones.has(zone)) {
    try {
      intl("en-US", { timeZone: zone })
      zones.set(zone, true)
    } catch {
      zones.set(zone, false)
    }
  }
  return zones.get(zone) ? zone : "UTC"
}

export type DateParts = { year: number; month: number; day: number; hour: number; minute: number; second: number }

export function partsIn(when: Date, zone: string): DateParts {
  const parts = intl("en-US", {
    timeZone: usableZone(zone),
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(when)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  }
}

const orders: Record<Exclude<DateFormat, "browser">, { order: ("day" | "month" | "year")[]; sep: string }> = {
  "DD/MM/YYYY": { order: ["day", "month", "year"], sep: "/" },
  "MM/DD/YYYY": { order: ["month", "day", "year"], sep: "/" },
  "YYYY-MM-DD": { order: ["year", "month", "day"], sep: "-" },
  "DD.MM.YYYY": { order: ["day", "month", "year"], sep: "." },
}
const pad2 = (n: number) => String(n).padStart(2, "0")
const directionMarks = new RegExp(`[${String.fromCharCode(0x200e, 0x200f, 0x061c)}]`, "g")

export function writeDate(p: DateParts, w: DateWriting, { year = true } = {}): string {
  if (w.date === "browser" || !(w.date in orders)) {
    const options: Intl.DateTimeFormatOptions = {
      timeZone: "UTC",
      calendar: "gregory",
      numberingSystem: "latn",
      day: "2-digit",
      month: "2-digit",
    }
    if (year) options.year = "numeric"
    const parts = intl(w.locale, options).formatToParts(new Date(Date.UTC(p.year, p.month - 1, p.day)))
    const numbers = parts.filter((x) => x.type === "day" || x.type === "month" || x.type === "year")
    const between = parts
      .slice(parts.indexOf(numbers[0] as Intl.DateTimeFormatPart) + 1)
      .find((x) => x.type === "literal")
      ?.value.replace(directionMarks, "")
      .trim()
    const sep = between && /^[./-]$/.test(between) ? between : "/"
    return numbers.map((x) => x.value).join(sep)
  }
  const { order, sep } = orders[w.date]
  const part = { day: pad2(p.day), month: pad2(p.month), year: String(p.year).padStart(4, "0") }
  return order
    .filter((k) => year || k !== "year")
    .map((k) => part[k])
    .join(sep)
}

function clockOf(w: DateWriting): Exclude<TimeFormat, "browser"> {
  if (w.time !== "browser") return w.time
  const cycle = intl(w.locale, { hour: "numeric" }).resolvedOptions().hourCycle
  return cycle === "h11" || cycle === "h12" ? "12h" : "24h"
}

export function writeClock(p: DateParts, w: DateWriting, { seconds = false, compact = false } = {}): string {
  const whole = compact && !seconds && p.minute === 0
  const tail = `${pad2(p.minute)}${seconds ? `:${pad2(p.second)}` : ""}`
  if (clockOf(w) === "12h") return `${p.hour % 12 || 12}${whole ? "" : `:${tail}`} ${p.hour < 12 ? "AM" : "PM"}`
  return `${pad2(p.hour)}:${tail}`
}

function instant(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatTime(value: string | number | Date, w: DateWriting, { seconds = true } = {}): string {
  const d = instant(value)
  if (!d) return "-"
  const p = partsIn(d, w.zone)
  return `${writeDate(p, w)}, ${writeClock(p, w, { seconds })}`
}

export function formatDay(value: string | number | Date, w: DateWriting, { year = true } = {}): string {
  const d = instant(value)
  return d ? writeDate(partsIn(d, w.zone), w, { year }) : "-"
}

export const formatDayMonth = (value: string | number | Date, w: DateWriting) => formatDay(value, w, { year: false })

export function formatClock(
  value: string | number | Date,
  w: DateWriting,
  options: { seconds?: boolean; compact?: boolean } = {},
): string {
  const d = instant(value)
  return d ? writeClock(partsIn(d, w.zone), w, options) : "-"
}

export function formatClockAt(hhmm: string, w: DateWriting): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return hhmm
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) return hhmm
  return writeClock({ year: 2000, month: 1, day: 1, hour, minute, second: 0 }, w)
}

export function formatListTime(value: string | number | Date, w: DateWriting, now: Date = new Date()): string {
  const d = instant(value)
  if (!d) return "-"
  const p = partsIn(d, w.zone)
  const today = partsIn(now, w.zone)
  if (p.year === today.year && p.month === today.month && p.day === today.day) return writeClock(p, w)
  return writeDate(p, w, { year: p.year !== today.year })
}

const offsetName = /^GMT[+-]/
export function zoneName(when: Date, zone: string): string {
  const z = usableZone(zone)
  const name = (locale: string) =>
    intl(locale, { timeZone: z, timeZoneName: "short" })
      .formatToParts(when)
      .find((p) => p.type === "timeZoneName")?.value ?? z
  const us = name("en-US")
  if (!offsetName.test(us)) return us
  const gb = name("en-GB")
  return offsetName.test(gb) ? us : gb
}

export function formatStamp(value: string | number | Date, w: DateWriting, { zone = true } = {}): string {
  const d = instant(value)
  if (!d) return "-"
  const p = partsIn(d, w.zone)
  const at = `${writeDate(p, w)} ${writeClock(p, w)}`
  return zone ? `${at} ${zoneName(d, w.zone)}` : at
}

export function formatWindow(from: Date, to: Date, w: DateWriting): string {
  const end = (d: Date) => {
    const p = partsIn(d, w.zone)
    return `${writeDate(p, w)} ${writeClock(p, w)}`
  }
  const a = zoneName(from, w.zone)
  const b = zoneName(to, w.zone)
  return a === b ? `From ${end(from)} to ${end(to)}` : `From ${end(from)} ${a} to ${end(to)} ${b}`
}

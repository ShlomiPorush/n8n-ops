/*
 * How dates and times are written, the same in the console, the emails and Telegram (FW-9, FW-2, EM-6). Settings
 * → General chooses a Date format and a Time format; every date is written in the app's time zone, as numbers,
 * never with a month name. "browser" leaves the order of the date, or the clock, to the browser's language; every
 * other choice reads the same everywhere. Only Intl is used, so the server and the UI run the same code.
 */

/** The Date format choices, Browser first: it is the default. */
export const dateFormats = ["browser", "DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD", "DD.MM.YYYY"] as const
export type DateFormat = (typeof dateFormats)[number]
/** The Time format choices; 24-hour is the default. */
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

/**
 * How to write a date: the app's time zone and the two formats. `locale` is the language Browser follows; left
 * out, it is the runtime's own (the browser's in the console).
 */
export type DateWriting = { zone: string; date: DateFormat; time: TimeFormat; locale?: string }

type General = { timezone?: string; dateFormat?: string; timeFormat?: string }

/** The writing General asks for; an empty zone is UTC, and an unknown format reads as its default. */
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

/**
 * The writing of an email or a Telegram message. There is no browser to ask, so Browser writes day/month/year and
 * the 24-hour clock there (EM-6).
 */
export function messageWriting(general: General | undefined): DateWriting {
  const w = writingOf(general)
  return {
    zone: w.zone,
    date: w.date === "browser" ? "DD/MM/YYYY" : w.date,
    time: w.time === "browser" ? "24h" : w.time,
  }
}

// Building an Intl.DateTimeFormat is slow, and a list writes one date per row.
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
/** The zone if this runtime knows it; empty or unknown is UTC, as the server falls back (FW-2). */
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

/** A calendar day and a clock time, as numbers. */
export type DateParts = { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** The day and the clock time of an instant in a time zone. */
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

/** A calendar day as the Date format writes it: "16/10/2026", or without the year "16/10". */
export function writeDate(p: DateParts, w: DateWriting, { year = true } = {}): string {
  if (w.date === "browser" || !(w.date in orders)) {
    const options: Intl.DateTimeFormatOptions = { timeZone: "UTC", day: "2-digit", month: "2-digit" }
    if (year) options.year = "numeric"
    return intl(w.locale, options).format(new Date(Date.UTC(p.year, p.month - 1, p.day)))
  }
  const { order, sep } = orders[w.date]
  const part = { day: pad2(p.day), month: pad2(p.month), year: String(p.year).padStart(4, "0") }
  return order
    .filter((k) => year || k !== "year")
    .map((k) => part[k])
    .join(sep)
}

/**
 * A clock time as the Time format writes it: "14:05", "2:05 PM", or as the browser's language does. `compact`
 * writes a whole hour on the 12-hour clock as "3 PM", for an axis.
 */
export function writeClock(p: DateParts, w: DateWriting, { seconds = false, compact = false } = {}): string {
  const whole = compact && !seconds && p.minute === 0
  if (w.time === "browser") {
    const rest: Intl.DateTimeFormatOptions = { minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) }
    const cycle = intl(w.locale, { timeZone: "UTC", hour: "numeric", ...rest }).resolvedOptions().hourCycle
    const twelve = cycle === "h11" || cycle === "h12"
    const options: Intl.DateTimeFormatOptions =
      twelve && whole ? { hour: "numeric" } : { hour: twelve ? "numeric" : "2-digit", ...rest }
    return intl(w.locale, { timeZone: "UTC", ...options }).format(
      new Date(Date.UTC(2000, 0, 1, p.hour, p.minute, p.second)),
    )
  }
  const tail = `${pad2(p.minute)}${seconds ? `:${pad2(p.second)}` : ""}`
  if (w.time === "12h") return `${p.hour % 12 || 12}${whole ? "" : `:${tail}`} ${p.hour < 12 ? "AM" : "PM"}`
  return `${pad2(p.hour)}:${tail}`
}

/** An instant from what the API sends; null when it names none. */
function instant(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** The date and the time to the second, "16/10/2026, 14:05:09"; `seconds: false` leaves them out (FW-2). */
export function formatTime(value: string | number | Date, w: DateWriting, { seconds = true } = {}): string {
  const d = instant(value)
  if (!d) return "-"
  const p = partsIn(d, w.zone)
  return `${writeDate(p, w)}, ${writeClock(p, w, { seconds })}`
}

/** The day of an instant, "16/10/2026"; `year: false` leaves the year out. */
export function formatDay(value: string | number | Date, w: DateWriting, { year = true } = {}): string {
  const d = instant(value)
  return d ? writeDate(partsIn(d, w.zone), w, { year }) : "-"
}

/** The day and month of an instant, "16/10". */
export const formatDayMonth = (value: string | number | Date, w: DateWriting) => formatDay(value, w, { year: false })

/** The clock time of an instant, "14:05" or "2:05 PM". */
export function formatClock(
  value: string | number | Date,
  w: DateWriting,
  options: { seconds?: boolean; compact?: boolean } = {},
): string {
  const d = instant(value)
  return d ? writeClock(partsIn(d, w.zone), w, options) : "-"
}

/**
 * A clock time stored as 24-hour "HH:MM", such as the daily backup at "02:00", as the Time format writes it
 * ("2:00 AM"). What is stored and sent stays "HH:MM"; anything else is shown as it is.
 */
export function formatClockAt(hhmm: string, w: DateWriting): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return hhmm
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) return hhmm
  return writeClock({ year: 2000, month: 1, day: 1, hour, minute, second: 0 }, w)
}

/**
 * A time in a list row (FW-1): the clock for today, day and month earlier this year, the whole date before;
 * "today" is the day in the app's time zone.
 */
export function formatListTime(value: string | number | Date, w: DateWriting, now: Date = new Date()): string {
  const d = instant(value)
  if (!d) return "-"
  const p = partsIn(d, w.zone)
  const today = partsIn(now, w.zone)
  if (p.year === today.year && p.month === today.month && p.day === today.day) return writeClock(p, w)
  return writeDate(p, w, { year: p.year !== today.year })
}

const offsetName = /^GMT[+-]/
/**
 * The short name of the zone at an instant: "CEST", "EDT", "UTC", or "GMT+3" where the zone has no common
 * abbreviation. English (US) knows the American names, English (UK) the European ones, so both are asked.
 */
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

/** A date and time with the zone after it, as messages write them: "20/10/2026 13:00 CEST" (EM-6). */
export function formatStamp(value: string | number | Date, w: DateWriting): string {
  const d = instant(value)
  if (!d) return "-"
  const p = partsIn(d, w.zone)
  return `${writeDate(p, w)} ${writeClock(p, w)} ${zoneName(d, w.zone)}`
}

/**
 * A span of time with its exact ends: "From 22/10/2026 06:00 to 23/10/2026 06:00 CEST". The zone is named once,
 * or at both ends when daylight saving changed in between (EM-6).
 */
export function formatWindow(from: Date, to: Date, w: DateWriting): string {
  const end = (d: Date) => {
    const p = partsIn(d, w.zone)
    return `${writeDate(p, w)} ${writeClock(p, w)}`
  }
  const a = zoneName(from, w.zone)
  const b = zoneName(to, w.zone)
  return a === b ? `From ${end(from)} to ${end(to)} ${b}` : `From ${end(from)} ${a} to ${end(to)} ${b}`
}

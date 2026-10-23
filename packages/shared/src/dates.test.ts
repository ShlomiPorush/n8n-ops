import { describe, expect, it } from "vitest"
import {
  type DateWriting,
  formatClock,
  formatClockAt,
  formatDay,
  formatDayMonth,
  formatListTime,
  formatStamp,
  formatTime,
  formatWindow,
  messageWriting,
  writingOf,
  zoneName,
} from "./dates.ts"

const w = (date: DateWriting["date"], time: DateWriting["time"] = "24h", zone = "UTC", locale?: string) =>
  ({ zone, date, time, ...(locale ? { locale } : {}) }) as DateWriting

// 16 October 2026, 13:05:09 UTC: a day after the twelfth, so day and month cannot be mixed up.
const at = new Date("2026-10-16T13:05:09Z")

describe("Date format (FW-9)", () => {
  it("writes each fixed order with numbers only", () => {
    expect(formatDay(at, w("DD/MM/YYYY"))).toBe("16/10/2026")
    expect(formatDay(at, w("MM/DD/YYYY"))).toBe("10/16/2026")
    expect(formatDay(at, w("YYYY-MM-DD"))).toBe("2026-10-16")
    expect(formatDay(at, w("DD.MM.YYYY"))).toBe("16.10.2026")
  })

  it("leaves the year out of day and month in the same order", () => {
    expect(formatDayMonth(at, w("DD/MM/YYYY"))).toBe("16/10")
    expect(formatDayMonth(at, w("MM/DD/YYYY"))).toBe("10/16")
    expect(formatDayMonth(at, w("YYYY-MM-DD"))).toBe("10-16")
    expect(formatDayMonth(at, w("DD.MM.YYYY"))).toBe("16.10")
  })

  it("follows the language's order for Browser, still in numbers", () => {
    expect(formatDay(at, w("browser", "24h", "UTC", "en-US"))).toBe("10/16/2026")
    expect(formatDay(at, w("browser", "24h", "UTC", "en-GB"))).toBe("16/10/2026")
    expect(formatDay(at, w("browser", "24h", "UTC", "de-DE"))).toBe("16.10.2026")
    expect(formatDay(at, w("browser", "24h", "UTC", "en-US"))).not.toMatch(/[A-Za-z]/)
  })

  it("writes the day in the app's time zone", () => {
    // 22:30 UTC is already the next day in Jerusalem.
    expect(formatDay(new Date("2026-10-16T22:30:00Z"), w("DD/MM/YYYY", "24h", "Asia/Jerusalem"))).toBe("17/10/2026")
  })
})

describe("Time format (FW-9)", () => {
  it("writes the 24-hour clock with leading zeros", () => {
    expect(formatClock(new Date("2026-10-16T02:05:00Z"), w("DD/MM/YYYY"))).toBe("02:05")
    expect(formatClock(at, w("DD/MM/YYYY"), { seconds: true })).toBe("13:05:09")
  })

  it("writes the 12-hour clock with AM and PM, midnight and noon as 12", () => {
    expect(formatClock(at, w("DD/MM/YYYY", "12h"))).toBe("1:05 PM")
    expect(formatClock(new Date("2026-10-16T00:30:00Z"), w("DD/MM/YYYY", "12h"))).toBe("12:30 AM")
    expect(formatClock(new Date("2026-10-16T12:00:00Z"), w("DD/MM/YYYY", "12h"))).toBe("12:00 PM")
    expect(formatClock(at, w("DD/MM/YYYY", "12h"), { seconds: true })).toBe("1:05:09 PM")
  })

  it("writes a whole hour as 3 PM on an axis, on the 12-hour clock only", () => {
    const three = new Date("2026-10-16T15:00:00Z")
    expect(formatClock(three, w("DD/MM/YYYY", "12h"), { compact: true })).toBe("3 PM")
    expect(formatClock(three, w("DD/MM/YYYY", "24h"), { compact: true })).toBe("15:00")
  })

  it("follows the language's clock for Browser", () => {
    expect(formatClock(at, w("DD/MM/YYYY", "browser", "UTC", "en-US"))).toMatch(/^1:05\sPM$/)
    expect(formatClock(at, w("DD/MM/YYYY", "browser", "UTC", "en-GB"))).toBe("13:05")
    expect(formatClock(new Date("2026-10-16T02:05:00Z"), w("DD/MM/YYYY", "browser", "UTC", "de-DE"))).toBe("02:05")
  })

  it("writes a stored HH:MM schedule in the chosen clock, and leaves anything else as it is", () => {
    expect(formatClockAt("02:00", w("DD/MM/YYYY", "24h"))).toBe("02:00")
    expect(formatClockAt("02:00", w("DD/MM/YYYY", "12h"))).toBe("2:00 AM")
    expect(formatClockAt("14:30", w("DD/MM/YYYY", "12h"))).toBe("2:30 PM")
    expect(formatClockAt("later", w("DD/MM/YYYY", "12h"))).toBe("later")
    expect(formatClockAt("25:00", w("DD/MM/YYYY", "12h"))).toBe("25:00")
  })
})

describe("full times and list times (FW-1, FW-2)", () => {
  it("writes the date and the time to the second, or without the seconds", () => {
    expect(formatTime(at, w("DD/MM/YYYY"))).toBe("16/10/2026, 13:05:09")
    expect(formatTime(at, w("YYYY-MM-DD", "12h"), { seconds: false })).toBe("2026-10-16, 1:05 PM")
    expect(formatTime("not a date", w("DD/MM/YYYY"))).toBe("-")
  })

  it("shows the clock for today, day and month earlier this year, the whole date before", () => {
    const now = new Date("2026-10-23T12:00:00Z")
    const fmt = w("DD/MM/YYYY")
    expect(formatListTime("2026-10-23T08:15:00Z", fmt, now)).toBe("08:15")
    expect(formatListTime("2026-10-16T08:15:00Z", fmt, now)).toBe("16/10")
    expect(formatListTime("2025-10-16T08:15:00Z", fmt, now)).toBe("16/10/2025")
    expect(formatListTime("2025-10-16T08:15:00Z", w("YYYY-MM-DD", "12h"), now)).toBe("2025-10-16")
    expect(formatListTime("2026-10-23T20:15:00Z", w("DD/MM/YYYY", "12h"), now)).toBe("8:15 PM")
  })

  it("decides what today is in the app's time zone", () => {
    // 23:30 UTC on the 22nd is 02:30 on the 23rd in Jerusalem: today there, yesterday in UTC.
    const now = new Date("2026-10-23T06:00:00Z")
    const before = "2026-10-22T23:30:00Z"
    expect(formatListTime(before, w("DD/MM/YYYY", "24h", "Asia/Jerusalem"), now)).toBe("02:30")
    expect(formatListTime(before, w("DD/MM/YYYY", "24h", "UTC"), now)).toBe("22/10")
  })
})

describe("zone names and windows in messages (EM-6)", () => {
  it("names the zone by its short name, or its offset where it has none", () => {
    const summer = new Date("2026-10-22T04:00:00Z")
    const winter = new Date("2026-12-22T04:00:00Z")
    expect(zoneName(summer, "Europe/Berlin")).toBe("CEST")
    expect(zoneName(winter, "Europe/Berlin")).toBe("CET")
    expect(zoneName(summer, "America/New_York")).toBe("EDT")
    expect(zoneName(summer, "Europe/London")).toBe("BST")
    expect(zoneName(winter, "Europe/London")).toBe("GMT")
    expect(zoneName(summer, "Asia/Jerusalem")).toBe("GMT+3")
    expect(zoneName(summer, "UTC")).toBe("UTC")
    expect(zoneName(summer, "Not/AZone")).toBe("UTC")
  })

  it("writes a time with its zone after it", () => {
    expect(formatStamp(new Date("2026-10-20T11:00:00Z"), w("DD/MM/YYYY", "24h", "Europe/Berlin"))).toBe(
      "20/10/2026 13:00 CEST",
    )
    expect(formatStamp(new Date("2026-10-20T11:00:00Z"), w("MM/DD/YYYY", "12h", "Europe/Berlin"))).toBe(
      "10/20/2026 1:00 PM CEST",
    )
  })

  it("gives a window its exact ends and names the zone once", () => {
    const fmt = w("DD.MM.YYYY", "24h", "Europe/Berlin")
    expect(formatWindow(new Date("2026-10-22T04:00:00Z"), new Date("2026-10-23T04:00:00Z"), fmt)).toBe(
      "From 22.10.2026 06:00 to 23.10.2026 06:00 CEST",
    )
  })

  it("names the zone at both ends when daylight saving changed inside the window", () => {
    // Berlin leaves summer time on 25 October 2026 at 03:00: 24 hours before 08:00 CET is 09:00 CEST.
    const fmt = w("DD/MM/YYYY", "24h", "Europe/Berlin")
    expect(formatWindow(new Date("2026-10-24T07:00:00Z"), new Date("2026-10-25T07:00:00Z"), fmt)).toBe(
      "From 24/10/2026 09:00 CEST to 25/10/2026 08:00 CET",
    )
  })

  it("writes Browser as day/month/year and the 24-hour clock, which a message cannot ask a browser for", () => {
    expect(messageWriting({ timezone: "", dateFormat: "browser", timeFormat: "browser" })).toEqual({
      zone: "UTC",
      date: "DD/MM/YYYY",
      time: "24h",
    })
    expect(messageWriting({ timezone: "Europe/Berlin", dateFormat: "YYYY-MM-DD", timeFormat: "12h" })).toEqual({
      zone: "Europe/Berlin",
      date: "YYYY-MM-DD",
      time: "12h",
    })
  })

  it("reads an unknown format as its default and an unknown zone as UTC", () => {
    expect(writingOf({ timezone: "Not/AZone", dateFormat: "D M Y", timeFormat: "36h" })).toEqual({
      zone: "UTC",
      date: "browser",
      time: "24h",
    })
  })
})

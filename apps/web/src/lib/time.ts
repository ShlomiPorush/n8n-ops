import { type DateWriting, writingOf } from "@n8n-ops/shared"
import { useQuery } from "@tanstack/react-query"
import { readFresh } from "./api"

/*
 * Every date and time on screen is written here (FW-9, FW-2): in the time zone set in Settings → General (UTC
 * when it is empty or this browser does not know it), in its Date format and Time format, as numbers. The writing
 * itself is shared with the emails and Telegram (`@n8n-ops/shared` dates.ts), so they read alike. design.test.ts
 * fails on a page that formats a date in another way.
 */

export {
  type DateWriting,
  formatClock,
  formatClockAt,
  formatDay,
  formatDayMonth,
  formatListTime,
  formatTime,
} from "@n8n-ops/shared"

type General = { timezone?: string; dateFormat?: string; timeFormat?: string }

/**
 * How this installation writes dates: its time zone and the two formats of Settings → General. Browser follows
 * this browser's language. A saved change shows at once: the save puts it in the cache this reads.
 */
export function useTimeFormat(): DateWriting {
  const general = useQuery({
    queryKey: ["/settings/general"],
    queryFn: () => readFresh<General>("/settings/general"),
    staleTime: 5 * 60_000,
  })
  return writingOf(general.data)
}

/** The instant a `<time dateTime>` names, so a list sorts by it and not by its text (TB-2); none when invalid. */
export function isoTime(value: string | number | Date): string | undefined {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

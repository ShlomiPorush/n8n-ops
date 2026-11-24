import { type DateWriting, writingOf } from "@n8n-ops/shared"
import { useQuery } from "@tanstack/react-query"
import { api } from "./api"

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

export function useTimeFormat(): DateWriting {
  const general = useQuery({
    queryKey: ["/settings/general"],
    queryFn: () => api<General>("/settings/general"),
    staleTime: 5 * 60_000,
  })
  return writingOf(general.data)
}

export function isoTime(value: string | number | Date): string | undefined {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

export function zoneOffset(zone: string, at: Date): string | null {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value
    return !name || name === "GMT" ? "UTC+00:00" : name.replace("GMT", "UTC")
  } catch {
    return null
  }
}

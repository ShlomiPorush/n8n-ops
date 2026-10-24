/**
 * How long, in at most two units with a zero one dropped (FW-4): "45 min", "2 h", "1 h 30 min". Shared so the
 * console, the emails and Telegram name an access length the same way.
 */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

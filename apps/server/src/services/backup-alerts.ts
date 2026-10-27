import { clip, html } from "./telegram.ts"

const on = (destination?: string) => (destination ? html` to ${clip(destination, 100)}` : html``)

/**
 * Telegram texts of the backup alerts. The names and the error come from outside and are shortened. With a
 * destination, the alert is about the copies on that destination only.
 */
export const backupAlerts = {
  failed: (name: string, error?: string, destination?: string) => {
    const what = destination
      ? html`Backup of ${clip(name, 200)} could not be copied to ${clip(destination, 100)}`
      : html`Backup failed on ${clip(name, 200)}`
    return html`<b>${what}</b>\n${clip(error ?? "", 500)}`
  },
  working: (name: string, destination?: string) =>
    html`<b>Backups of ${clip(name, 200)}${on(destination)} are working again</b>`,
  stale: (name: string, hours: number, destination?: string) => {
    const n = clip(name, 200)
    const last = hours === 1 ? "hour" : `${hours} hours`
    if (!destination) return html`<b>No recent backup of ${n}</b>\nNo backup of ${n} from the last ${last} succeeded.`
    const d = clip(destination, 100)
    return html`<b>No recent backup of ${n} on ${d}</b>
No backup of ${n} from the last ${last} has been copied to ${d}.`
  },
}

/** The ongoing-condition key of backups of an instance (or of n8n-ops itself) on one destination. */
export const backupCondition = (instanceId: string | null, destinationId: string) =>
  `backup:${instanceId ?? "self"}:${destinationId}`

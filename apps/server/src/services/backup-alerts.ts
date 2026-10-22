import { clip, html } from "./telegram.ts"

const on = (destination?: string) => (destination ? html` to ${clip(destination, 100)}` : html``)

/**
 * Telegram texts of the backup alerts. The names and the error come from outside and are shortened. With a
 * destination, the alert is about the copies on that destination only.
 */
export const backupAlerts = {
  failed: (name: string, error?: string, destination?: string) =>
    html`<b>Backup failed on ${clip(name, 200)}${on(destination)}</b>\n${clip(error ?? "", 500)}`,
  working: (name: string, destination?: string) =>
    html`<b>Backups of ${clip(name, 200)}${on(destination)} are working again</b>`,
  stale: (name: string, hours: number, destination?: string) =>
    html`<b>Backup is stale on ${clip(name, 200)}${on(destination)}</b>\nNo successful backup for more than ${hours} hours.`,
}

/** The ongoing-condition key of backups of an instance (or of n8n-ops itself) on one destination. */
export const backupCondition = (instanceId: string | null, destinationId: string) =>
  `backup:${instanceId ?? "self"}:${destinationId}`

/*
 * Checks for values typed in Settings. The UI runs them before a save and the server runs them when it stores a
 * changed value, so both refuse the same entries in the same words (SV-1, SV-12). A problem is written to follow
 * its field's label: "Recipients: "bob" is not an email address".
 */

/** The label of each setting, as Settings shows it; the server names a refused field with it. */
export const settingLabels = {
  general: { publicUrl: "Public URL", timezone: "Time zone", design: "Design" },
  alerts: {
    newProblem: "New problem",
    regression: "Regression",
    health: "Instance or worker down, queue backlog",
    backup: "Backup failed or stale",
    groupingWindowSec: "Grouping window (seconds)",
    editWindowMin: "Edit instead of resend (minutes)",
    retryMin: "Retry failed sends every (minutes)",
  },
  telegram: { botToken: "Bot token", chatId: "Chat ID" },
  email: {
    dailyEnabled: "Daily report",
    dailyTime: "Daily report time",
    weeklyEnabled: "Weekly report",
    weeklyDay: "Weekly report day",
    weeklyTime: "Weekly report time",
    recipients: "Recipients",
    from: "From address",
    smtpHost: "SMTP server",
    smtpPort: "SMTP port",
    smtpSecure: "TLS from the start (port 465)",
    smtpUser: "SMTP user",
    smtpPassword: "SMTP password",
  },
  defaults: {
    pollIntervalSec: "Check for failures every (seconds)",
    healthIntervalSec: "Health check every (seconds)",
    backupTime: "Daily backup time",
    staleBackupHours: "Backup is stale after (hours)",
    executionRetentionDays: "Keep failed executions (days)",
    autoResolveDays: "Auto-resolve after days without failures",
    backlogThreshold: "Queue backlog alert (waiting jobs)",
    backlogMinutes: "for longer than (minutes)",
  },
  access: {
    maxMinutes: "Longest access (minutes)",
    pendingMinutes: "A request waits for a decision (minutes)",
    notifyTelegram: "Send requests to Telegram",
    notifyEmail: "Email requests",
    telegramApprovers: "Who may approve in Telegram",
  },
  backups: {
    selfDestinations: "Where the n8n-ops database goes",
    selfDestinationIds: "Destinations",
    maxArchiveMb: "Largest archive (MiB)",
  },
} as const satisfies Record<string, Record<string, string>>

/** The label of a setting, or its key when it has none. */
export function settingLabel(section: string, field: string): string {
  const labels = (settingLabels as Record<string, Record<string, string>>)[section]
  return labels?.[field] ?? field
}

/** Splits typed or pasted text into entries: commas, semicolons, spaces and line breaks separate them (SV-12). */
export const splitEntries = (text: string): string[] =>
  text
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)

const label = String.raw`[^\s@<>()[\],;:".]+`
const emailPattern = new RegExp(String.raw`^[^\s@<>()[\],;:"]+@${label}(\.${label})+$`)

/** An address mail can be sent to: a name, @, and a domain with at least one dot ("bob@exmaple" is refused). */
export const isEmailAddress = (value: string): boolean => emailPattern.test(value)

/** A Telegram user as the approver check reads it: the numeric user ID, or @username. */
export const isTelegramUser = (value: string): boolean =>
  /^\d{1,20}$/.test(value) || /^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(value)

/** A Telegram chat: its numeric ID (groups and channels are negative), or a channel's @username. */
export const isTelegramChat = (value: string): boolean =>
  /^-?\d{1,20}$/.test(value) || /^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(value)

/** A 24-hour time as HH:MM. */
export const isClockTime = (value: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)

/** A web address that starts with http:// or https:// and names a host. */
export function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== ""
  } catch {
    return false
  }
}

/** A From address: an email address, or a name with the address in angle brackets. */
export function isFromAddress(value: string): boolean {
  const named = /^[^<>]*<([^<>]+)>$/.exec(value)
  return isEmailAddress((named?.[1] ?? value).trim())
}

/** What a setting's value must be, beyond its type. Empty single values are allowed: they mean not set. */
export type ValueKind = "emails" | "telegram-users" | "telegram-chat" | "time" | "web-address" | "from-address"

/** The settings checked beyond their type, by section and field. Numbers are checked against their limits. */
export const settingKinds: Record<string, Record<string, ValueKind>> = {
  general: { publicUrl: "web-address" },
  telegram: { chatId: "telegram-chat" },
  email: { recipients: "emails", from: "from-address", dailyTime: "time", weeklyTime: "time" },
  defaults: { backupTime: "time" },
  access: { telegramApprovers: "telegram-users" },
}

const quoted = (entries: string[]) => {
  const q = entries.map((e) => `"${e}"`)
  return q.length < 2 ? (q[0] ?? "") : `${q.slice(0, -1).join(", ")} and ${q.at(-1)}`
}

/** The entries of a list that are not what the list takes, named in one sentence; null when all are. */
function listProblem(entries: string[], ok: (v: string) => boolean, one: string, many: string): string | null {
  const bad = entries.filter((e) => !ok(e))
  if (bad.length === 0) return null
  return `${quoted(bad)} ${bad.length === 1 ? `is not ${one}` : `are not ${many}`}`
}

/** What is wrong with a value of this kind, in words that follow its label; null when it is fine. */
export function valueProblem(kind: ValueKind, value: unknown): string | null {
  if (kind === "emails" || kind === "telegram-users") {
    const entries = Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : []
    return kind === "emails"
      ? listProblem(entries, isEmailAddress, "an email address", "email addresses")
      : listProblem(entries, isTelegramUser, "a Telegram user ID or @username", "Telegram user IDs or @usernames")
  }
  const text = String(value ?? "").trim()
  if (kind === "time") return isClockTime(text) ? null : "use a 24-hour time as HH:MM, for example 07:30"
  if (text === "") return null
  if (kind === "telegram-chat")
    return isTelegramChat(text) ? null : "use the chat's number, such as -1001234567890, or a channel's @username"
  if (kind === "web-address")
    return isWebAddress(text) ? null : "use a full address that starts with https://, such as https://ops.example.com"
  return isFromAddress(text) ? null : "use an email address, such as n8n-ops@example.com, or Name <n8n-ops@example.com>"
}

/** The range a number setting takes, as the server's schema sets it. */
export type NumberLimits = { min?: number; max?: number }

/** What is wrong with a number setting; null when it is a whole number inside its limits. */
export function numberProblem(value: unknown, { min, max }: NumberLimits): string | null {
  const text = String(value ?? "").trim()
  const n = Number(text)
  const ok = text !== "" && Number.isInteger(n) && (min === undefined || n >= min) && (max === undefined || n <= max)
  if (ok) return null
  if (min !== undefined && max !== undefined) return `use a whole number from ${min} to ${max}`
  if (min !== undefined) return `use a whole number of at least ${min}`
  if (max !== undefined) return `use a whole number up to ${max}`
  return "use a whole number"
}

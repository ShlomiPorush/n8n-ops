export const settingLabels = {
  general: {
    publicUrl: "Public URL",
    timezone: "Time zone",
    dateFormat: "Date format",
    timeFormat: "Time format",
    design: "Design",
    releaseCheckHours: "Check for new n8n releases every (hours)",
  },
  alerts: {
    newProblem: "New problem",
    regression: "Regression",
    health: "Instance or queue worker down, queue backlog",
    backup: "Backup failed or late",
    groupingWindowSec: "Grouping window (seconds)",
    editWindowMin: "Edit instead of resend (minutes)",
    retryMin: "Retry failed sends every (minutes)",
  },
  telegram: {
    botToken: "Bot token",
    chatId: "Chat ID",
    defaultThreadId: "Default topic",
    accessThreadId: "Access requests topic",
    routes: "Topic routes",
  },
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
    smtpAllowUnencrypted: "Allow sending without encryption",
    smtpUser: "SMTP user",
    smtpPassword: "SMTP password",
  },
  defaults: {
    pollIntervalSec: "Check for failures every (seconds)",
    healthIntervalSec: "Collect health every (seconds)",
    downAfterFailures: "Down alert after failed checks in a row",
    backupTime: "Daily backup time",
    staleBackupHours: "Backup is late after (hours)",
    executionRetentionDays: "Keep failed executions (days)",
    healthHistoryDays: "Keep health history (days)",
    autoResolveDays: "Auto-resolve after days without failures",
    backlogThreshold: "Queue backlog alert (waiting jobs)",
    backlogMinutes: "Queue backlog alert after (minutes)",
    workflowMapMinutes: "Refresh workflows and execution counts every (minutes)",
    instanceCheckHours: "Check the n8n version and API key every (hours)",
  },
  access: {
    maxMinutes: "Longest access (minutes)",
    pendingMinutes: "A request waits for a decision (minutes)",
    notifyTelegram: "Send requests to Telegram",
    notifyEmail: "Email requests",
    defaultNotify: "Default channels",
    telegramApprovers: "Who may approve in Telegram",
  },
  agents: {
    enabled: "Agents can connect",
    idleDays: "Disconnect an unused agent after (days)",
  },
  security: {
    lifetimeHours: "Sign out an unused session after (hours)",
    idleTimeout: "Sign out after inactivity",
    idleMinutes: "Inactivity limit (minutes)",
    maxHours: "Longest session (hours)",
  },
  backups: {
    selfDestinations: "Where the n8n-ops database goes",
    selfDestinationIds: "Destinations",
    maxArchiveMb: "Largest archive (MiB)",
  },
} as const satisfies Record<string, Record<string, string>>

export function settingLabel(section: string, field: string): string {
  const labels = (settingLabels as Record<string, Record<string, string>>)[section]
  return labels?.[field] ?? field
}

export const splitEntries = (text: string): string[] =>
  text
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)

const label = String.raw`[^\s@<>()[\],;:".]+`
const emailPattern = new RegExp(String.raw`^[^\s@<>()[\],;:"]+@${label}(\.${label})+$`)

export const isEmailAddress = (value: string): boolean => emailPattern.test(value)

export const isTelegramUser = (value: string): boolean =>
  /^\d{1,20}$/.test(value) || /^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(value)

export const isTelegramChat = (value: string): boolean =>
  /^-?\d{1,20}$/.test(value) || /^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(value)

export const isClockTime = (value: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)

export function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== ""
  } catch {
    return false
  }
}

export function isFromAddress(value: string): boolean {
  const named = /^[^<>]*<([^<>]+)>$/.exec(value)
  return isEmailAddress((named?.[1] ?? value).trim())
}

export const accessChannels = ["telegram", "email"] as const
export type AccessChannel = (typeof accessChannels)[number]
export const accessChannelLabels: Record<AccessChannel, string> = { telegram: "Telegram", email: "Email" }

export type ValueKind =
  | "emails"
  | "telegram-users"
  | "telegram-chat"
  | "time"
  | "web-address"
  | "from-address"
  | "channels"

export const settingKinds: Record<string, Record<string, ValueKind>> = {
  general: { publicUrl: "web-address" },
  telegram: { chatId: "telegram-chat" },
  email: { recipients: "emails", from: "from-address", dailyTime: "time", weeklyTime: "time" },
  defaults: { backupTime: "time" },
  access: { telegramApprovers: "telegram-users", defaultNotify: "channels" },
}

const quoted = (entries: string[]) => {
  const q = entries.map((e) => `"${e}"`)
  return q.length < 2 ? (q[0] ?? "") : `${q.slice(0, -1).join(", ")} and ${q.at(-1)}`
}

function listProblem(entries: string[], ok: (v: string) => boolean, one: string, many: string): string | null {
  const bad = entries.filter((e) => !ok(e))
  if (bad.length === 0) return null
  return `${quoted(bad)} ${bad.length === 1 ? `is not ${one}` : `are not ${many}`}`
}

export function valueProblem(kind: ValueKind, value: unknown): string | null {
  if (kind === "channels") {
    const list = Array.isArray(value) ? value : []
    const known = (v: unknown) => accessChannels.some((c) => c === v)
    return list.length && list.every(known)
      ? null
      : `choose at least one of ${accessChannels.map((c) => accessChannelLabels[c]).join(" and ")}`
  }
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

export const maxTopicId = 2_147_483_647

export const topicWords = "use the topic's number, such as 12"

export function topicProblem(value: unknown): string | null {
  const text = String(value ?? "").trim()
  if (text === "") return null
  return /^\d{1,10}$/.test(text) && Number(text) >= 1 && Number(text) <= maxTopicId ? null : topicWords
}

export function isRoutePattern(pattern: string): boolean {
  try {
    new RegExp(pattern, "iu")
    return true
  } catch {
    return false
  }
}

export const maxRoutes = 50
export const routeLimits = { workflow: 200, tag: 100 } as const

export const routeWords = {
  condition: "choose an instance, or type a workflow pattern or a tag",
  pattern: "the workflow pattern is not a valid regular expression",
  patternLength: `keep the workflow pattern to ${routeLimits.workflow} characters`,
  tagLength: `keep the tag to ${routeLimits.tag} characters`,
} as const

export type NumberLimits = { min?: number; max?: number }

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

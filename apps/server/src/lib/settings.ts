import {
  dateFormats,
  isDateFormat,
  isTimeFormat,
  type NumberLimits,
  numberProblem,
  settingKinds,
  settingLabel,
  timeFormats,
  valueProblem,
} from "@n8n-ops/shared"
import { eq } from "drizzle-orm"
import { z } from "zod"
import type { Db } from "../db/client.ts"
import { settings as settingsTable } from "../db/schema.ts"

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM")

/** Settings an instance can override. Everything else is global. */
export const instanceSettingsSchema = z.object({
  pollIntervalSec: z.number().int().min(15).max(3600),
  healthIntervalSec: z.number().int().min(10).max(3600),
  backupTime: time,
  staleBackupHours: z.number().int().min(1).max(720),
  executionRetentionDays: z.number().int().min(1).max(3650),
  autoResolveDays: z.number().int().min(1).max(365),
  backlogThreshold: z.number().int().min(1),
  backlogMinutes: z.number().int().min(1).max(1440),
})
export type InstanceSettings = z.infer<typeof instanceSettingsSchema>
export const instanceOverridesSchema = instanceSettingsSchema.partial()
export type InstanceOverrides = z.infer<typeof instanceOverridesSchema>

/** The two web designs. Regular is the default; Compact is the denser v3 design. */
export const designs = ["regular", "compact"] as const
export type Design = (typeof designs)[number]
export const isDesign = (value: unknown): value is Design => designs.includes(value as Design)

/** A time zone the schedules and dates can use: anything Intl takes, also a fixed offset such as +03:00. */
export function isKnownZone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false
  try {
    new Intl.DateTimeFormat("en", { timeZone: value })
    return true
  } catch {
    return false
  }
}

/**
 * An IANA time zone name, such as Europe/Berlin or UTC: what a new time zone must be. A fixed offset such as
 * +03:00 is refused although Intl takes it, since it would not follow daylight saving; one stored before
 * keeps working until it is replaced.
 */
export const isTimeZone = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z][\w+-]*(\/[\w+-]+)*$/.test(value) && isKnownZone(value)

/** Whether General may be saved with this time zone: a zone name, empty (UTC), or the one already stored. */
export const mayStoreTimeZone = (stored: unknown, next: unknown) => next === stored || next === "" || isTimeZone(next)

type SmtpAccount = { smtpHost?: unknown; smtpPort?: unknown; smtpUser?: unknown }

/** The SMTP account as a comparable text: host without case or spaces, the port as a number, the user trimmed. */
const smtpAccount = (v: SmtpAccount) =>
  JSON.stringify([
    String(v.smtpHost ?? "")
      .trim()
      .toLowerCase(),
    Number(v.smtpPort ?? 0),
    String(v.smtpUser ?? "").trim(),
  ])

/**
 * Whether an Email save would send the stored SMTP password where it was not given: the host, port or user
 * really changed (case, spaces and "587" against 587 do not count) and the save brings no new password (FS-5).
 */
export const smtpPasswordNeeded = (
  current: SmtpAccount & { smtpPasswordEnc?: unknown },
  next: SmtpAccount,
  newPassword: unknown,
) =>
  Boolean(current.smtpPasswordEnc) &&
  !(typeof newPassword === "string" && newPassword.length > 0) &&
  newPassword !== null &&
  smtpAccount(current) !== smtpAccount(next)

export const sections = {
  general: z.object({
    /** Public URL of this n8n-ops installation, used in links sent by Telegram and email. */
    publicUrl: z.string(),
    /** Empty means UTC. A new value must also pass isTimeZone (checked where it is saved). */
    timezone: z.string().refine((v) => v === "" || isKnownZone(v), "choose a time zone from the list"),
    /** How the console, the emails and Telegram write a date and a time (FW-9, EM-6). */
    dateFormat: z.enum(dateFormats),
    timeFormat: z.enum(timeFormats),
    /** Which of the two web designs the whole installation uses. */
    design: z.enum(designs),
  }),
  defaults: instanceSettingsSchema,
  alerts: z.object({
    newProblem: z.boolean(),
    regression: z.boolean(),
    health: z.boolean(),
    backup: z.boolean(),
    groupingWindowSec: z.number().int().min(0).max(3600),
    editWindowMin: z.number().int().min(0).max(1440),
    retryMin: z.number().int().min(1).max(60),
  }),
  telegram: z.object({
    botTokenEnc: z.string().optional(),
    chatId: z.string(),
    webhookSecret: z.string(),
  }),
  email: z.object({
    dailyEnabled: z.boolean(),
    dailyTime: time,
    weeklyEnabled: z.boolean(),
    weeklyDay: z.number().int().min(0).max(6),
    weeklyTime: time,
    recipients: z.array(z.string()),
    from: z.string(),
    smtpHost: z.string(),
    smtpPort: z.number().int().min(1).max(65535),
    smtpSecure: z.boolean(),
    smtpUser: z.string(),
    smtpPasswordEnc: z.string().optional(),
  }),
  backups: z.object({
    /** Where the n8n-ops database backup goes: the default destinations, or those listed. */
    selfDestinations: z.enum(["default", "custom"]),
    selfDestinationIds: z.array(z.string().uuid()),
    /** Largest archive accepted, in MiB. Archives are built in memory, so this also bounds memory use. */
    maxArchiveMb: z.number().int().min(16).max(20_480),
  }),
  access: z.object({
    /** Longest temporary access an agent may get to an n8n instance. */
    maxMinutes: z
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60),
    /** A request nobody approves or denies in this time expires. */
    pendingMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60),
    /** Send each new request to the Telegram chat with Approve and Deny buttons. */
    notifyTelegram: z.boolean(),
    /** Email each new request to the report recipients, with a link to decide in n8n-ops. */
    notifyEmail: z.boolean(),
    /**
     * Telegram user IDs or @usernames allowed to press Approve or Deny. Empty: only the user of a private chat
     * (the chat ID is that user), never anyone in a group.
     */
    telegramApprovers: z.array(z.string()),
  }),
  keys: z.object({
    /** age public key used to encrypt every backup archive. */
    backupRecipient: z.string().optional(),
    privateKeySavedAt: z.string().optional(),
  }),
} as const

export type SectionName = keyof typeof sections
export type Section<K extends SectionName> = z.infer<(typeof sections)[K]>

export const defaults: { [K in SectionName]: Section<K> } = {
  general: { publicUrl: "", timezone: "UTC", dateFormat: "browser", timeFormat: "24h", design: "regular" },
  defaults: {
    pollIntervalSec: 60,
    healthIntervalSec: 30,
    backupTime: "02:00",
    staleBackupHours: 26,
    executionRetentionDays: 30,
    autoResolveDays: 7,
    backlogThreshold: 200,
    backlogMinutes: 5,
  },
  alerts: {
    newProblem: true,
    regression: true,
    health: true,
    backup: true,
    groupingWindowSec: 120,
    editWindowMin: 60,
    retryMin: 5,
  },
  telegram: { chatId: "", webhookSecret: "" },
  email: {
    dailyEnabled: false,
    dailyTime: "07:30",
    weeklyEnabled: false,
    weeklyDay: 0,
    weeklyTime: "08:00",
    recipients: [],
    from: "",
    smtpHost: "",
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: "",
  },
  backups: { selfDestinations: "default", selfDestinationIds: [], maxArchiveMb: 2048 },
  access: { maxMinutes: 240, pendingMinutes: 30, notifyTelegram: true, notifyEmail: true, telegramApprovers: [] },
  keys: {},
}

/** The range of each number setting of a section, read from its schema, so the UI checks the same (SV-1). */
export function numberLimits(section: SectionName): Record<string, NumberLimits> {
  const out: Record<string, NumberLimits> = {}
  for (const [name, schema] of Object.entries(sections[section].shape)) {
    if (!(schema instanceof z.ZodNumber)) continue
    // .int() alone bounds a number by the safe integers; only a limit set on purpose is one.
    const set = (v: number | null) => v !== null && Math.abs(v) < Number.MAX_SAFE_INTEGER
    const { minValue, maxValue } = schema
    out[name] = {
      ...(set(minValue) ? { min: minValue as number } : {}),
      ...(set(maxValue) ? { max: maxValue as number } : {}),
    }
  }
  return out
}

export type Issue = { path: (string | number)[]; message: string }

/**
 * Checks the fields a save changes beyond their type, as the UI does before it sends them: list entries, the chat,
 * addresses (SV-12). Only changed fields: an entry stored before these checks stays until its field is edited.
 */
export function changedValueIssues(
  section: SectionName,
  stored: Record<string, unknown>,
  next: Record<string, unknown>,
): Issue[] {
  const kinds = settingKinds[section] ?? {}
  return Object.entries(kinds).flatMap(([field, kind]) => {
    if (JSON.stringify(stored[field]) === JSON.stringify(next[field])) return []
    const problem = valueProblem(kind, next[field])
    return problem ? [{ path: [field], message: problem }] : []
  })
}

/** Schema issues in words that follow the field's label, instead of the schema's own ("Too small: expected…"). */
export function wordedIssues(section: SectionName, issues: readonly z.core.$ZodIssue[]): Issue[] {
  const limits = numberLimits(section)
  const kinds = settingKinds[section] ?? {}
  return issues.map((issue) => {
    const field = String(issue.path[0] ?? "")
    const kind = kinds[field]
    const message =
      field in limits
        ? numberProblem(undefined, limits[field] ?? {})
        : kind
          ? valueProblem(kind, undefined)
          : issue.code === "invalid_value"
            ? `choose one of ${issue.values.map(String).join(", ")}`
            : issue.message
    return { path: field ? [field] : [], message: message ?? issue.message }
  })
}

/** The answer to a save the checks refused: each field named by its label, as "<Label>: <problem>" (SV-1). */
export function invalidAnswer(section: SectionName, issues: Issue[]) {
  return {
    error: "invalid",
    issues,
    message: issues.map((i) => `${settingLabel(section, String(i.path[0] ?? section))}: ${i.message}`).join(" "),
  }
}

export type SettingsStore = {
  /**
   * The settings in effect: stored values over the defaults, and the public URL from N8N_OPS_PUBLIC_URL while
   * none is stored.
   */
  get<K extends SectionName>(key: K): Promise<Section<K>>
  /**
   * What is stored, over the defaults, without anything taken from the environment. A save starts from this, so
   * a value from the environment is never written by a save that did not change it (FS-6).
   */
  stored<K extends SectionName>(key: K): Promise<Section<K>>
  /** Values the environment provides when none is stored: N8N_OPS_PUBLIC_URL. */
  fromEnv(): { publicUrl?: string }
  set<K extends SectionName>(key: K, value: Section<K>): Promise<void>
  /** Effective settings for one instance: global defaults with its overrides applied. */
  forInstance(overrides: Record<string, unknown>): Promise<InstanceSettings>
  /**
   * The design the web UI is served in, held in memory so serving a page never waits for the database. It
   * follows every saved General and assumes one server process, which is the supported deployment.
   */
  design(): Design
  /**
   * Reads the stored design. If the database does not answer, the default stays and the read is retried in
   * the background until it succeeds. Call once after migrations.
   */
  loadDesign(log: Logger, retryMs?: number): Promise<void>
}

type Logger = { info(msg: string, meta?: object): void; warn(msg: string, meta?: object): void }

/**
 * `env.publicUrl` (N8N_OPS_PUBLIC_URL) stands in for the public URL while Settings > General leaves it empty,
 * so links in alerts, the Telegram webhook and worker install commands use the address users open.
 */
export function createSettings(db: Db, env: { publicUrl?: string } = {}): SettingsStore {
  let currentDesign: Design = defaults.general.design
  // General is written one at a time, so the design in memory always ends as the last one stored.
  let generalWrites: Promise<unknown> = Promise.resolve()
  let generalVersion = 0

  async function get<K extends SectionName>(key: K): Promise<Section<K>> {
    const value = await stored(key)
    if (key === "general" && env.publicUrl) {
      const general = value as Section<"general">
      if (!general.publicUrl) return { ...general, publicUrl: env.publicUrl } as Section<K>
    }
    return value
  }

  async function stored<K extends SectionName>(key: K): Promise<Section<K>> {
    const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, key))
    const stored = { ...((row?.value as Record<string, unknown>) ?? {}) }
    // An unknown stored design falls back on its own; it must not reset the rest of General.
    if (key === "general" && "design" in stored && !isDesign(stored.design)) delete stored.design
    // So does a time zone Intl does not know, saved before time zones were checked: it reads as UTC.
    if (key === "general" && "timezone" in stored && stored.timezone !== "" && !isKnownZone(stored.timezone))
      delete stored.timezone
    // And a date or time format this release does not know: it reads as its default (FW-9).
    if (key === "general" && "dateFormat" in stored && !isDateFormat(stored.dateFormat)) delete stored.dateFormat
    if (key === "general" && "timeFormat" in stored && !isTimeFormat(stored.timeFormat)) delete stored.timeFormat
    const merged = { ...defaults[key], ...stored }
    const parsed = sections[key].safeParse(merged)
    return (parsed.success ? parsed.data : defaults[key]) as Section<K>
  }

  async function write<K extends SectionName>(key: K, parsed: Section<K>) {
    await db
      .insert(settingsTable)
      .values({ key, value: parsed, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: parsed, updatedAt: new Date() } })
  }

  return {
    get,
    stored,
    fromEnv: () => (env.publicUrl ? { publicUrl: env.publicUrl } : {}),
    async set(key, value) {
      const parsed = sections[key].parse(value) as typeof value
      if (key !== "general") return write(key, parsed)
      const run = generalWrites.then(async () => {
        await write(key, parsed)
        // Updated where the value is stored, so a later failure in the request cannot leave memory behind.
        currentDesign = (parsed as Section<"general">).design
        generalVersion += 1
      })
      generalWrites = run.catch(() => {})
      await run
    },
    async forInstance(overrides) {
      return resolveInstanceSettings(await get("defaults"), overrides)
    },
    design: () => currentDesign,
    loadDesign,
  }

  async function loadDesign(log: Logger, retryMs = 5_000): Promise<void> {
    try {
      // A General saved while this read was on its way is newer than what the read returns: keep it.
      const seen = generalVersion
      const stored = (await get("general")).design
      if (generalVersion === seen) currentDesign = stored
    } catch (error) {
      log.warn("Could not read the web design; serving the default until the database answers", {
        error: (error as Error).message,
      })
      setTimeout(() => void loadDesign(log, Math.min(retryMs * 2, 60_000)), retryMs).unref?.()
    }
  }
}

export function resolveInstanceSettings(base: InstanceSettings, overrides: Record<string, unknown>): InstanceSettings {
  const parsed = instanceOverridesSchema.safeParse(overrides)
  const clean = parsed.success ? Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) : {}
  return { ...base, ...clean }
}

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

export const sections = {
  general: z.object({
    /** Public URL of this n8n-ops installation, used in links sent by Telegram and email. */
    publicUrl: z.string(),
    /** Empty means UTC. A new value must also pass isTimeZone (checked where it is saved). */
    timezone: z.string().refine((v) => v === "" || isKnownZone(v), "choose a time zone from the list"),
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
  general: { publicUrl: "", timezone: "UTC", design: "regular" },
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

export type SettingsStore = {
  get<K extends SectionName>(key: K): Promise<Section<K>>
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
    const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, key))
    const stored = { ...((row?.value as Record<string, unknown>) ?? {}) }
    // An unknown stored design falls back on its own; it must not reset the rest of General.
    if (key === "general" && "design" in stored && !isDesign(stored.design)) delete stored.design
    // So does a time zone Intl does not know, saved before time zones were checked: it reads as UTC.
    if (key === "general" && "timezone" in stored && stored.timezone !== "" && !isKnownZone(stored.timezone))
      delete stored.timezone
    const merged = { ...defaults[key], ...stored }
    const parsed = sections[key].safeParse(merged)
    const value = (parsed.success ? parsed.data : defaults[key]) as Section<K>
    if (key === "general" && env.publicUrl) {
      const general = value as Section<"general">
      if (!general.publicUrl) return { ...general, publicUrl: env.publicUrl } as Section<K>
    }
    return value
  }

  async function write<K extends SectionName>(key: K, parsed: Section<K>) {
    await db
      .insert(settingsTable)
      .values({ key, value: parsed, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: parsed, updatedAt: new Date() } })
  }

  return {
    get,
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

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
  retentionDaily: z.number().int().min(1).max(90),
  retentionWeekly: z.number().int().min(0).max(52),
  retentionMonthly: z.number().int().min(0).max(60),
  staleBackupHours: z.number().int().min(1).max(720),
  executionRetentionDays: z.number().int().min(1).max(3650),
  autoResolveDays: z.number().int().min(1).max(365),
  backlogThreshold: z.number().int().min(1),
  backlogMinutes: z.number().int().min(1).max(1440),
})
export type InstanceSettings = z.infer<typeof instanceSettingsSchema>
export const instanceOverridesSchema = instanceSettingsSchema.partial()
export type InstanceOverrides = z.infer<typeof instanceOverridesSchema>

export const sections = {
  general: z.object({
    /** Public URL of this n8n-ops installation, used in links sent by Telegram and email. */
    publicUrl: z.string(),
    timezone: z.string(),
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
  storage: z.object({
    endpoint: z.string(),
    region: z.string(),
    bucket: z.string(),
    prefix: z.string(),
    accessKeyId: z.string(),
    secretAccessKeyEnc: z.string().optional(),
    forcePathStyle: z.boolean(),
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
  general: { publicUrl: "", timezone: "UTC" },
  defaults: {
    pollIntervalSec: 60,
    healthIntervalSec: 30,
    backupTime: "02:00",
    retentionDaily: 7,
    retentionWeekly: 4,
    retentionMonthly: 6,
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
  storage: { endpoint: "", region: "us-east-1", bucket: "", prefix: "n8n-ops", accessKeyId: "", forcePathStyle: true },
  keys: {},
}

export type SettingsStore = {
  get<K extends SectionName>(key: K): Promise<Section<K>>
  set<K extends SectionName>(key: K, value: Section<K>): Promise<void>
  /** Effective settings for one instance: global defaults with its overrides applied. */
  forInstance(overrides: Record<string, unknown>): Promise<InstanceSettings>
}

export function createSettings(db: Db): SettingsStore {
  async function get<K extends SectionName>(key: K): Promise<Section<K>> {
    const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, key))
    const merged = { ...defaults[key], ...((row?.value as object) ?? {}) }
    const parsed = sections[key].safeParse(merged)
    return (parsed.success ? parsed.data : defaults[key]) as Section<K>
  }
  return {
    get,
    async set(key, value) {
      const parsed = sections[key].parse(value)
      await db
        .insert(settingsTable)
        .values({ key, value: parsed, updatedAt: new Date() })
        .onConflictDoUpdate({ target: settingsTable.key, set: { value: parsed, updatedAt: new Date() } })
    },
    async forInstance(overrides) {
      return resolveInstanceSettings(await get("defaults"), overrides)
    },
  }
}

export function resolveInstanceSettings(base: InstanceSettings, overrides: Record<string, unknown>): InstanceSettings {
  const parsed = instanceOverridesSchema.safeParse(overrides)
  const clean = parsed.success ? Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) : {}
  return { ...base, ...clean }
}

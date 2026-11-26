import {
  accessChannels,
  dateFormats,
  isRoutePattern,
  maxRoutes,
  maxTopicId,
  type NumberLimits,
  numberProblem,
  routeLimits,
  routeWords,
  settingKinds,
  settingLabel,
  timeFormats,
  topicWords,
  valueProblem,
} from "@n8n-ops/shared"
import { eq, sql } from "drizzle-orm"
import { z } from "zod"
import type { Db } from "../db/client.ts"
import { settings as settingsTable } from "../db/schema.ts"

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM")

export const maxSessionHours = 720

export const instanceSettingsSchema = z.object({
  pollIntervalSec: z.number().int().min(15).max(3600),
  healthIntervalSec: z.number().int().min(10).max(3600),
  downAfterFailures: z.number().int().min(3).max(20),
  backupTime: time,
  staleBackupHours: z.number().int().min(1).max(720),
  executionRetentionDays: z.number().int().min(1).max(3650),
  healthHistoryDays: z.number().int().min(1).max(30),
  autoResolveDays: z.number().int().min(1).max(365),
  backlogThreshold: z.number().int().min(1),
  backlogMinutes: z.number().int().min(1).max(1440),
  workflowMapMinutes: z.number().int().min(1).max(1440),
  instanceCheckHours: z.number().int().min(1).max(168),
})
export type InstanceSettings = z.infer<typeof instanceSettingsSchema>
export const instanceOverridesSchema = instanceSettingsSchema.partial()
export type InstanceOverrides = z.infer<typeof instanceOverridesSchema>

export const designs = ["regular", "compact"] as const
export type Design = (typeof designs)[number]

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z][\w+-]*(\/[\w+-]+)*$/.test(value)) return false
  try {
    new Intl.DateTimeFormat("en", { timeZone: value })
    return true
  } catch {
    return false
  }
}

export const topicIdSchema = z
  .number({ error: topicWords })
  .int({ error: topicWords })
  .min(1, { error: topicWords })
  .max(maxTopicId, { error: topicWords })

const condition = (max: number, tooLong?: string) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v.trim() || undefined : v),
    z
      .string()
      .max(max, tooLong ? { error: tooLong } : undefined)
      .optional(),
  )

export const telegramRouteSchema = z
  .object({
    instanceId: condition(64),
    workflow: condition(routeLimits.workflow, routeWords.patternLength).refine(
      (p) => p === undefined || isRoutePattern(p),
      routeWords.pattern,
    ),
    tag: condition(routeLimits.tag, routeWords.tagLength),
    threadId: topicIdSchema,
  })
  .refine((r) => Boolean(r.instanceId || r.workflow || r.tag), routeWords.condition)
export type TelegramRoute = z.infer<typeof telegramRouteSchema>

type SmtpAccount = {
  smtpHost?: unknown
  smtpPort?: unknown
  smtpUser?: unknown
  smtpSecure?: unknown
  smtpAllowUnencrypted?: unknown
}

const smtpAccount = (v: SmtpAccount) =>
  JSON.stringify([
    String(v.smtpHost ?? "")
      .trim()
      .toLowerCase(),
    Number(v.smtpPort ?? 0),
    String(v.smtpUser ?? "").trim(),
    Boolean(v.smtpSecure),
    Boolean(v.smtpAllowUnencrypted),
  ])

export const smtpPasswordNeeded = (
  current: SmtpAccount & { smtpPasswordEnc?: unknown },
  next: SmtpAccount,
  newPassword: unknown,
) =>
  Boolean(current.smtpPasswordEnc) &&
  !(typeof newPassword === "string" && newPassword.length > 0) &&
  newPassword !== null &&
  smtpAccount(current) !== smtpAccount(next)

export const AGENT_IDLE_MAX_DAYS = 365

export const sections = {
  general: z.object({
    publicUrl: z.string(),
    timezone: z.string().refine((v) => v === "" || isTimeZone(v), "choose a time zone from the list"),
    dateFormat: z.enum(dateFormats),
    timeFormat: z.enum(timeFormats),
    design: z.enum(designs),
    releaseCheckHours: z.number().int().min(1).max(168),
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
    routes: z.array(telegramRouteSchema).max(maxRoutes),
    defaultThreadId: topicIdSchema.nullable(),
    accessThreadId: topicIdSchema.nullable(),
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
    smtpAllowUnencrypted: z.boolean(),
    smtpUser: z.string(),
    smtpPasswordEnc: z.string().optional(),
  }),
  backups: z.object({
    selfDestinations: z.enum(["default", "custom"]),
    selfDestinationIds: z.array(z.string().uuid()),
    maxArchiveMb: z.number().int().min(16).max(20_480),
  }),
  access: z.object({
    maxMinutes: z
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60),
    pendingMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60),
    notifyTelegram: z.boolean(),
    notifyEmail: z.boolean(),
    defaultNotify: z.array(z.enum(accessChannels)).min(1),
    telegramApprovers: z.array(z.string()),
  }),
  agents: z.object({
    enabled: z.boolean(),
    idleDays: z.number().int().min(1).max(AGENT_IDLE_MAX_DAYS),
  }),
  security: z.object({
    lifetimeHours: z.number().int().min(1).max(maxSessionHours),
    idleTimeout: z.boolean(),
    idleMinutes: z.number().int().min(5).max(1440),
    maxHours: z.number().int().min(1).max(maxSessionHours),
  }),
  keys: z.object({
    backupRecipient: z.string().optional(),
    privateKeySavedAt: z.string().optional(),
  }),
  sessionSignOuts: z.object({
    generation: z.number().int().min(0),
    keptSessionId: z.string().nullable(),
  }),
} as const

export type SectionName = keyof typeof sections
export type Section<K extends SectionName> = z.infer<(typeof sections)[K]>

export const defaults: { [K in SectionName]: Section<K> } = {
  general: {
    publicUrl: "",
    timezone: "UTC",
    dateFormat: "browser",
    timeFormat: "24h",
    design: "regular",
    releaseCheckHours: 6,
  },
  defaults: {
    pollIntervalSec: 60,
    healthIntervalSec: 30,
    downAfterFailures: 3,
    backupTime: "02:00",
    staleBackupHours: 26,
    executionRetentionDays: 30,
    healthHistoryDays: 30,
    autoResolveDays: 7,
    backlogThreshold: 200,
    backlogMinutes: 5,
    workflowMapMinutes: 10,
    instanceCheckHours: 6,
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
  telegram: { chatId: "", webhookSecret: "", routes: [], defaultThreadId: null, accessThreadId: null },
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
    smtpAllowUnencrypted: false,
    smtpUser: "",
  },
  backups: { selfDestinations: "default", selfDestinationIds: [], maxArchiveMb: 2048 },
  access: {
    maxMinutes: 240,
    pendingMinutes: 30,
    notifyTelegram: true,
    notifyEmail: true,
    defaultNotify: ["telegram", "email"],
    telegramApprovers: [],
  },
  agents: { enabled: false, idleDays: 90 },
  security: { lifetimeHours: 24, idleTimeout: true, idleMinutes: 60, maxHours: 12 },
  keys: {},
  sessionSignOuts: { generation: 0, keptSessionId: null },
}

export async function writeSection<K extends Exclude<SectionName, "general">>(
  db: Pick<Db, "insert">,
  key: K,
  value: Section<K>,
) {
  const parsed = sections[key].parse(value)
  await db
    .insert(settingsTable)
    .values({ key, value: parsed, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: parsed, updatedAt: new Date() } })
}

export async function readSection<K extends SectionName>(db: Pick<Db, "select">, key: K): Promise<Section<K>> {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, key))
  return storedValue(key, row?.value)
}

function storedValue<K extends SectionName>(key: K, value: unknown): Section<K> {
  const stored = { ...((value as Record<string, unknown> | null | undefined) ?? {}) }
  if (key === "general")
    for (const [name, schema] of Object.entries(sections.general.shape))
      if (name in stored && !schema.safeParse(stored[name]).success) delete stored[name]
  if (key === "telegram" && Array.isArray(stored.routes))
    stored.routes = stored.routes.filter((r) => telegramRouteSchema.safeParse(r).success).slice(0, maxRoutes)
  const merged = { ...defaults[key], ...stored }
  const parsed = sections[key].safeParse(merged)
  return (parsed.success ? parsed.data : defaults[key]) as Section<K>
}

export function numberLimits(section: SectionName): Record<string, NumberLimits> {
  const out: Record<string, NumberLimits> = {}
  for (const [name, schema] of Object.entries(sections[section].shape)) {
    if (!(schema instanceof z.ZodNumber)) continue
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
    const route = field === "routes" && typeof issue.path[1] === "number" ? `route ${issue.path[1] + 1}: ` : ""
    return { path: field ? [field] : [], message: route + (message ?? issue.message) }
  })
}

export function invalidAnswer(section: SectionName, issues: Issue[]) {
  return {
    error: "invalid",
    issues,
    message: issues.map((i) => `${settingLabel(section, String(i.path[0] ?? section))}: ${i.message}`).join(" "),
  }
}

export type SettingsEnv = { publicUrl?: string; smtpAllowUnencrypted?: boolean }

export const withEmailEnv = (email: Section<"email">, env: SettingsEnv): Section<"email"> =>
  env.smtpAllowUnencrypted === undefined ? email : { ...email, smtpAllowUnencrypted: env.smtpAllowUnencrypted }

export type SettingsStore = {
  get<K extends SectionName>(key: K): Promise<Section<K>>
  stored<K extends SectionName>(key: K): Promise<Section<K>>
  fromEnv(): SettingsEnv
  set<K extends SectionName>(key: K, value: Section<K>): Promise<void>
  merge<K extends SectionName>(key: K, change: Partial<Section<K>>): Promise<Section<K>>
  forInstance(overrides: Record<string, unknown>): Promise<InstanceSettings>
  design(): Design
  loadDesign(): Promise<void>
}

export function createSettings(db: Db, env: SettingsEnv = {}): SettingsStore {
  let currentDesign: Design = defaults.general.design

  async function get<K extends SectionName>(key: K): Promise<Section<K>> {
    const value = await stored(key)
    if (key === "general" && env.publicUrl) {
      const general = value as Section<"general">
      if (!general.publicUrl) return { ...general, publicUrl: env.publicUrl } as Section<K>
    }
    if (key === "email") return withEmailEnv(value as Section<"email">, env) as Section<K>
    return value
  }

  async function stored<K extends SectionName>(key: K): Promise<Section<K>> {
    return readSection(db, key)
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
    fromEnv: () => ({
      ...(env.publicUrl ? { publicUrl: env.publicUrl } : {}),
      ...(env.smtpAllowUnencrypted === undefined ? {} : { smtpAllowUnencrypted: env.smtpAllowUnencrypted }),
    }),
    async set(key, value) {
      const parsed = sections[key].parse(value) as typeof value
      await write(key, parsed)
      if (key === "general") currentDesign = (parsed as Section<"general">).design
    },
    async merge(key, change) {
      const parsed = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`settings:${key}`}))`)
        const next = sections[key].parse({ ...(await readSection(tx, key)), ...change }) as Section<typeof key>
        await tx
          .insert(settingsTable)
          .values({ key, value: next, updatedAt: new Date() })
          .onConflictDoUpdate({ target: settingsTable.key, set: { value: next, updatedAt: new Date() } })
        return next
      })
      if (key === "general") currentDesign = (parsed as Section<"general">).design
      return parsed
    },
    async forInstance(overrides) {
      return resolveInstanceSettings(await get("defaults"), overrides)
    },
    design: () => currentDesign,
    async loadDesign() {
      currentDesign = (await stored("general")).design
    },
  }
}

export function resolveInstanceSettings(base: InstanceSettings, overrides: Record<string, unknown>): InstanceSettings {
  const parsed = instanceOverridesSchema.safeParse(overrides)
  const clean = parsed.success ? Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) : {}
  return { ...base, ...clean }
}

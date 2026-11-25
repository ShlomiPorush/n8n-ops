import { randomBytes } from "node:crypto"
import { Hono } from "hono"
import type { Ctx } from "../context.ts"
import { requireUser, sessionEndedAnswer } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import {
  changedValueIssues,
  defaults,
  invalidAnswer,
  numberLimits,
  type Section,
  type SectionName,
  sections,
  smtpPasswordNeeded,
  wordedIssues,
} from "../lib/settings.ts"
import { issuerOf } from "../oauth/agents.ts"
import { syncTelegramWebhook } from "../services/alerts.ts"
import { storeClocks } from "../services/session-policy.ts"

const secretFields: Partial<Record<SectionName, string[]>> = {
  telegram: ["botToken"],
  email: ["smtpPassword"],
}

const editable: SectionName[] = [
  "general",
  "defaults",
  "alerts",
  "telegram",
  "email",
  "backups",
  "access",
  "security",
  "agents",
]

const envVariables = {
  publicUrl: "N8N_OPS_PUBLIC_URL",
  smtpAllowUnencrypted: "N8N_OPS_SMTP_ALLOW_UNENCRYPTED",
} as const

type EnvValue = { variable: string; value: string; inUse: boolean; locked?: boolean }

export function settingsRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))

  app.get("/:section", async (c) => {
    const section = c.req.param("section") as SectionName
    if (!editable.includes(section)) return c.json({ error: "not_found" }, 404)
    const value = { ...(await ctx.settings.get(section)) } as Record<string, unknown>
    for (const field of secretFields[section] ?? []) {
      value[`${field}Set`] = Boolean(value[`${field}Enc`])
      delete value[`${field}Enc`]
    }
    if (section === "telegram") delete value.webhookSecret
    const env: Record<string, EnvValue> = {}
    if (section === "general") {
      const { publicUrl } = ctx.settings.fromEnv()
      if (publicUrl)
        env.publicUrl = {
          variable: envVariables.publicUrl,
          value: publicUrl,
          inUse: !(await ctx.settings.stored("general")).publicUrl,
        }
    }
    const { smtpAllowUnencrypted } = ctx.settings.fromEnv()
    if (section === "email" && smtpAllowUnencrypted !== undefined)
      env.smtpAllowUnencrypted = {
        variable: envVariables.smtpAllowUnencrypted,
        value: String(smtpAllowUnencrypted),
        inUse: true,
        locked: true,
      }
    return c.json({ ...value, meta: { defaults: defaults[section], limits: numberLimits(section), env } })
  })

  app.put("/:section", async (c) => {
    const section = c.req.param("section") as SectionName
    if (!editable.includes(section)) return c.json({ error: "not_found" }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== "object") return c.json({ error: "invalid" }, 400)
    const current = (await ctx.settings.stored(section)) as Record<string, unknown>
    const sent = Object.fromEntries(
      Object.entries(body).filter(([k]) => k in sections[section].shape && !k.endsWith("Enc")),
    )
    const next: Record<string, unknown> = { ...current, ...sent }
    const envUrl = ctx.settings.fromEnv().publicUrl
    if (section === "general" && !current.publicUrl && envUrl && next.publicUrl === envUrl) next.publicUrl = ""
    const envPlain = ctx.settings.fromEnv().smtpAllowUnencrypted
    if (section === "email" && envPlain !== undefined && "smtpAllowUnencrypted" in body) {
      if (body.smtpAllowUnencrypted !== envPlain)
        return c.json(
          invalidAnswer(section, [
            { path: ["smtpAllowUnencrypted"], message: `set by ${envVariables.smtpAllowUnencrypted}` },
          ]),
          400,
        )
      next.smtpAllowUnencrypted = current.smtpAllowUnencrypted
    }
    if (section === "email" && smtpPasswordNeeded(current, next, body.smtpPassword))
      return c.json(
        {
          error: "password_needed",
          message:
            "The SMTP server, user or encryption changed. Enter the SMTP password again, so the stored one is not sent under them.",
          issues: [{ path: ["smtpPassword"], message: "enter it again for the new server" }],
        },
        400,
      )
    const secretNames = secretFields[section] ?? []
    for (const field of secretNames) {
      const plain = body[field]
      if (typeof plain === "string" && plain.length > 0) next[`${field}Enc`] = ctx.secrets.encrypt(plain)
      if (plain === null) delete next[`${field}Enc`]
    }
    if (section === "telegram" && !next.webhookSecret) next.webhookSecret = randomBytes(24).toString("hex")
    const parsed = sections[section].safeParse(next)
    if (!parsed.success) return c.json(invalidAnswer(section, wordedIssues(section, parsed.error.issues)), 400)
    const issues = changedValueIssues(section, current, next)
    if (issues.length) return c.json(invalidAnswer(section, issues), 400)
    const before = section === "general" ? (await ctx.settings.get("general")).publicUrl : null
    const who = { by: actorName(c.get("actor")), via: "web" as const }
    const changed = {
      actor: actorName(c.get("actor")),
      action: "Settings changed",
      target: section,
      via: "web" as const,
      details: {
        fields: Object.keys(body).filter((k) => !secretNames.includes(k)),
        secretsChanged: Object.keys(body).filter((k) => secretNames.includes(k)),
      },
    }
    if (section === "security") {
      const actor = c.get("actor")
      if (actor.kind !== "user") return c.json({ error: "unauthorized" }, 401)
      const stored = await storeClocks(ctx, parsed.data as Section<"security">, {
        sessionId: actor.sessionId,
        userId: actor.id,
        actor: actor.username,
        changed,
      })
      if (!stored.ok) return c.json(sessionEndedAnswer(stored.reason), 401)
      return c.json(stored.signedOut ? { ok: true, signedOut: true } : { ok: true })
    }
    if (section === "agents" && ctx.agents) await ctx.agents.saveSettings(sent as Partial<Section<"agents">>, who)
    else await ctx.settings.set(section, parsed.data as never)
    await ctx.audit(changed)
    if (section === "general" && ctx.agents) {
      const { publicUrl } = await ctx.settings.get("general")
      if (before !== publicUrl) await ctx.agents.reconcileIssuer(issuerOf(publicUrl), who)
    }
    if (section === "telegram" || section === "general")
      await syncTelegramWebhook(ctx).catch((e: Error) => ctx.log.warn("Telegram webhook not set", { error: e.message }))
    return c.json({ ok: true })
  })

  return app
}

import { randomBytes } from "node:crypto"
import { Hono } from "hono"
import type { Ctx } from "../context.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import {
  changedValueIssues,
  defaults,
  invalidAnswer,
  mayStoreTimeZone,
  numberLimits,
  type SectionName,
  sections,
  smtpPasswordNeeded,
  wordedIssues,
} from "../lib/settings.ts"
import { syncTelegramWebhook } from "../services/alerts.ts"

/** Secret fields: stored encrypted as <name>Enc, written as plain <name>, read back only as <name>Set. */
const secretFields: Partial<Record<SectionName, string[]>> = {
  telegram: ["botToken"],
  email: ["smtpPassword"],
}

const editable: SectionName[] = ["general", "defaults", "alerts", "telegram", "email", "backups", "access"]

/** The variable each value from the environment comes from, for the note under its field (FS-6). */
const envVariables = { publicUrl: "N8N_OPS_PUBLIC_URL" } as const

export function settingsRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))

  /**
   * The settings in effect, for every reader, and under `meta` what a form needs beside them (FS-6, SV-1): the
   * defaults, the range of each number, and which values come from the environment while none is stored.
   */
  app.get("/:section", async (c) => {
    const section = c.req.param("section") as SectionName
    if (!editable.includes(section)) return c.json({ error: "not_found" }, 404)
    const value = { ...(await ctx.settings.get(section)) } as Record<string, unknown>
    for (const field of secretFields[section] ?? []) {
      value[`${field}Set`] = Boolean(value[`${field}Enc`])
      delete value[`${field}Enc`]
    }
    if (section === "telegram") delete value.webhookSecret
    const env: Record<string, { variable: string; value: string; inUse: boolean }> = {}
    if (section === "general") {
      const { publicUrl } = ctx.settings.fromEnv()
      if (publicUrl)
        env.publicUrl = {
          variable: envVariables.publicUrl,
          value: publicUrl,
          inUse: !(await ctx.settings.stored("general")).publicUrl,
        }
    }
    return c.json({ ...value, meta: { defaults: defaults[section], limits: numberLimits(section), env } })
  })

  app.put("/:section", async (c) => {
    const section = c.req.param("section") as SectionName
    if (!editable.includes(section)) return c.json({ error: "not_found" }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== "object") return c.json({ error: "invalid" }, 400)
    // A save changes what is stored, never what the environment provides: the public URL from N8N_OPS_PUBLIC_URL
    // stays there, so a later change of the variable applies (FS-6).
    const current = (await ctx.settings.stored(section)) as Record<string, unknown>
    const next: Record<string, unknown> = { ...current }
    for (const [k, v] of Object.entries(body)) {
      if (k in sections[section].shape && !k.endsWith("Enc")) next[k] = v
    }
    // A client that sends back the whole section it read sends the value in effect: that is not a change.
    const envUrl = ctx.settings.fromEnv().publicUrl
    if (section === "general" && !current.publicUrl && envUrl && next.publicUrl === envUrl) next.publicUrl = ""
    // The stored SMTP password is never sent to a server it was not given for (FS-5).
    if (section === "email" && smtpPasswordNeeded(current, next, body.smtpPassword))
      return c.json(
        {
          error: "password_needed",
          message:
            "The SMTP server or user changed. Enter the SMTP password again, so the stored one is not sent to it.",
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
    // Entries are checked once their field changes, in the same words as the UI (SV-12).
    const issues = changedValueIssues(section, current, next)
    // A new time zone must be a zone name; a fixed offset saved before stays until it is replaced.
    if (section === "general" && !mayStoreTimeZone(current.timezone, next.timezone))
      issues.push({ path: ["timezone"], message: "choose a time zone from the list" })
    if (issues.length) return c.json(invalidAnswer(section, issues), 400)
    const before = section === "general" ? (await ctx.settings.get("general")).publicUrl : null
    await ctx.settings.set(section, parsed.data as never)
    await ctx.audit({
      actor: actorName(c.get("actor")),
      action: "Settings changed",
      target: section,
      via: "web",
      details: {
        fields: Object.keys(body).filter((k) => !secretNames.includes(k)),
        secretsChanged: Object.keys(body).filter((k) => secretNames.includes(k)),
      },
    })
    // Agents connected to the old address hold tokens issued by it; they connect again at the new one.
    if (section === "general" && ctx.agents && before !== (await ctx.settings.get("general")).publicUrl)
      await ctx.agents.endAll("address", { by: actorName(c.get("actor")), via: "web" })
    // Point the bot at this installation now rather than at the next minute check.
    if (section === "telegram" || section === "general")
      await syncTelegramWebhook(ctx).catch((e: Error) => ctx.log.warn("Telegram webhook not set", { error: e.message }))
    return c.json({ ok: true })
  })

  return app
}

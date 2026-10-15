import { randomBytes } from "node:crypto"
import { Hono } from "hono"
import type { Ctx } from "../context.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import { type SectionName, sections } from "../lib/settings.ts"

/** Secret fields: stored encrypted as <name>Enc, written as plain <name>, read back only as <name>Set. */
const secretFields: Partial<Record<SectionName, string[]>> = {
  telegram: ["botToken"],
  email: ["smtpPassword"],
  storage: ["secretAccessKey"],
}

const editable: SectionName[] = ["general", "defaults", "alerts", "telegram", "email", "storage", "access"]

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
    return c.json(value)
  })

  app.put("/:section", async (c) => {
    const section = c.req.param("section") as SectionName
    if (!editable.includes(section)) return c.json({ error: "not_found" }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== "object") return c.json({ error: "invalid" }, 400)
    const current = (await ctx.settings.get(section)) as Record<string, unknown>
    const next: Record<string, unknown> = { ...current }
    for (const [k, v] of Object.entries(body)) {
      if (k in sections[section].shape && !k.endsWith("Enc")) next[k] = v
    }
    const secretNames = secretFields[section] ?? []
    for (const field of secretNames) {
      const plain = body[field]
      if (typeof plain === "string" && plain.length > 0) next[`${field}Enc`] = ctx.secrets.encrypt(plain)
      if (plain === null) delete next[`${field}Enc`]
    }
    if (section === "telegram" && !next.webhookSecret) next.webhookSecret = randomBytes(24).toString("hex")
    const parsed = sections[section].safeParse(next)
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400)
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
    return c.json({ ok: true })
  })

  return app
}

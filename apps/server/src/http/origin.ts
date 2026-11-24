import type { Context } from "hono"
import { csrf } from "hono/csrf"
import { HTTPException } from "hono/http-exception"
import type { Ctx } from "../context.ts"

export function fromOwnPage(c: Context, publicUrl?: string | null): boolean {
  const origin = c.req.header("origin")
  if (!origin) return false
  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return false
  }
  if (publicUrl) {
    try {
      if (new URL(publicUrl).origin === origin) return true
    } catch {}
  }
  return host === new URL(c.req.url).host || host === c.req.header("host")
}

export const OTHER_PAGE = "Changes are accepted only from n8n-ops' own pages."

export async function fromAnotherPage(ctx: Pick<Ctx, "settings">, c: Context): Promise<Response | null> {
  const guard = csrf({ origin: async (_origin, cc) => fromOwnPage(cc, (await ctx.settings.get("general")).publicUrl) })
  try {
    await guard(c, async () => {})
    return null
  } catch (error) {
    if (error instanceof HTTPException && error.status === 403)
      return c.json({ error: "forbidden", message: OTHER_PAGE }, 403)
    throw error
  }
}

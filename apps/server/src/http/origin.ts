import type { Context } from "hono"
import { csrf } from "hono/csrf"
import { HTTPException } from "hono/http-exception"
import type { Ctx } from "../context.ts"

/**
 * Whether a request that changes something comes from a page of this installation: its Origin is the public URL,
 * or names the host the request was made to. The host is compared without the scheme because the server sits
 * behind a proxy that ends TLS, where the request it sees is plain HTTP while the page is HTTPS. SameSite cookies
 * alone are not relied on.
 */
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
    } catch {
      // An unusable public URL allows nothing.
    }
  }
  return host === new URL(c.req.url).host || host === c.req.header("host")
}

export const OTHER_PAGE = "Changes are accepted only from n8n-ops' own pages."

/**
 * Refuses a change a browser could send from another page without asking the server first: Hono's csrf middleware
 * (a method other than GET or HEAD with a form-like or missing Content-Type, from a page that is not this
 * installation's by Sec-Fetch-Site or by `fromOwnPage`). Other changes need a CORS preflight, which no cookie route
 * grants. Returns the 403 answer, or null when the request may go on.
 */
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

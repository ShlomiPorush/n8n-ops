import type { Context } from "hono"

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

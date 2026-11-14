import type { IncomingMessage } from "node:http"
import type { Context } from "hono"

type Bindings = { incoming: IncomingMessage }

/** The Node request under Hono; null when the app is driven without a server (unit tests). */
export const incomingOf = (c: Context) => (c.env as Partial<Bindings> | undefined)?.incoming ?? null

/**
 * The caller's address: the socket's, or the last X-Forwarded-For address when the socket is a proxy listed in
 * N8N_OPS_TRUSTED_PROXIES. A forwarded header from anyone else is ignored.
 */
export function addressOf(req: IncomingMessage | null) {
  const socket = req?.socket?.remoteAddress ?? "unknown"
  const trusted = (process.env.N8N_OPS_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  // The address the trusted proxy appended: the last one. Earlier entries come from the client and can be made up.
  const forwarded = req?.headers["x-forwarded-for"]
  const value = Array.isArray(forwarded) ? forwarded.join(",") : forwarded
  if (trusted.includes(socket)) return value?.split(",").at(-1)?.trim() || socket
  return socket
}

/** How many times a header was sent: Node keeps only the first Authorization, so count the raw headers. */
export function headerCount(c: Context, name: string) {
  const req = incomingOf(c)
  if (!req) return c.req.header(name) === undefined ? 0 : 1
  let n = 0
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]?.toLowerCase() === name) n++
  return n
}

/** A small fixed-window limit per key. It counts before anything else runs; `refund` gives a counted one back. */
export function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { at: number; n: number }>()
  const check = (key: string) => {
    const now = Date.now()
    const hit = hits.get(key)
    if (!hit || now - hit.at > windowMs) {
      hits.set(key, { at: now, n: 1 })
      if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.at > windowMs) hits.delete(k)
      return true
    }
    hit.n++
    return hit.n <= max
  }
  check.refund = (key: string) => {
    const hit = hits.get(key)
    if (hit && hit.n > 0) hit.n--
  }
  /** Whether this check is the first one over the limit in its window: log a block once. */
  check.firstOver = (key: string) => hits.get(key)?.n === max + 1
  return check
}

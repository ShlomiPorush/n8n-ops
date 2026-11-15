import type { IncomingMessage } from "node:http"
import { BlockList, isIP } from "node:net"
import type { Context } from "hono"

type Bindings = { incoming: IncomingMessage }

/** The Node request under Hono; null when the app is driven without a server (unit tests). */
export const incomingOf = (c: Context) => (c.env as Partial<Bindings> | undefined)?.incoming ?? null

/**
 * Proxies trusted when N8N_OPS_TRUSTED_PROXIES is not set: loopback and private networks, where the reverse proxy
 * of the shipped deployment (Traefik on a Docker network) and a proxy on the same host connect from. IPv4-mapped
 * IPv6 peers (::ffff:10.0.0.1) match the IPv4 ranges.
 */
const DEFAULT_TRUSTED_PROXIES = ["127.0.0.0/8", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"]

/**
 * The proxies whose X-Forwarded-For is believed: a comma-separated list of addresses and CIDR ranges, such as
 * "172.18.0.0/16, fd00::/8". Empty entries are skipped; no entry at all means the built-in list, and any entry
 * replaces it. Throws on an entry that is neither, naming it.
 */
export function trustedProxies(value: string | undefined): BlockList {
  const entries = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const list = new BlockList()
  for (const entry of entries.length ? entries : DEFAULT_TRUSTED_PROXIES) {
    const [address = "", prefix, extra] = entry.split("/")
    const family = isIP(address)
    const bits = family === 4 ? 32 : 128
    if (!family || extra !== undefined || (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) || Number(prefix) > bits)
      throw new Error(`N8N_OPS_TRUSTED_PROXIES: "${entry}" is not an IP address or a CIDR range`)
    const type = family === 4 ? "ipv4" : "ipv6"
    if (prefix === undefined) list.addAddress(address, type)
    else list.addSubnet(address, Number(prefix), type)
  }
  return list
}

let cached: { value: string | undefined; list: BlockList } | undefined

/** An IPv4 address that reached a dual-stack socket as ::ffff:a.b.c.d, written as plain IPv4. */
const plain = (address: string) =>
  address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address

/**
 * The caller's address: the socket's, or, when the socket is a trusted proxy (N8N_OPS_TRUSTED_PROXIES, by default
 * loopback and private networks), the last X-Forwarded-For address. A forwarded header from anyone else is ignored.
 */
export function addressOf(req: IncomingMessage | null) {
  const socket = req?.socket?.remoteAddress
  if (!socket || !isIP(socket)) return socket ?? "unknown"
  const value = process.env.N8N_OPS_TRUSTED_PROXIES
  if (!cached || cached.value !== value) cached = { value, list: trustedProxies(value) }
  if (!cached.list.check(socket, isIP(socket) === 4 ? "ipv4" : "ipv6")) return plain(socket)
  // The address the trusted proxy appended: the last one. Earlier entries come from the client and can be made up.
  const forwarded = req.headers["x-forwarded-for"]
  const last = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded)?.split(",").at(-1)?.trim()
  return plain(last && isIP(last) ? last : socket)
}

/** How many times a header was sent: Node keeps only the first Authorization, so count the raw headers. */
export function headerCount(c: Context, name: string) {
  const req = incomingOf(c)
  if (!req) return c.req.header(name) === undefined ? 0 : 1
  let n = 0
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]?.toLowerCase() === name) n++
  return n
}

/**
 * A small fixed-window limit per key. It counts before anything else runs; `refund` gives a counted one back.
 * Windows run on the monotonic clock. Keys stay in the order their windows started, so every check forgets the
 * ended ones from the front and stops at the first that is still running.
 */
export function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { at: number; n: number }>()
  const check = (key: string) => {
    const now = performance.now()
    for (const [k, v] of hits) {
      if (now - v.at <= windowMs) break
      hits.delete(k)
    }
    const hit = hits.get(key)
    if (!hit) {
      hits.set(key, { at: now, n: 1 })
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
  /** How many keys are kept. */
  check.size = () => hits.size
  return check
}

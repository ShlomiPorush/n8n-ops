import type { IncomingMessage } from "node:http"
import { BlockList, isIP } from "node:net"
import type { Context } from "hono"

type Bindings = { incoming: IncomingMessage }

export const incomingOf = (c: Context) => (c.env as Partial<Bindings> | undefined)?.incoming ?? null

const DEFAULT_TRUSTED_PROXIES = ["127.0.0.0/8", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"]

export function trustedProxies(value: string | undefined): (address: string) => boolean {
  const entries = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const list = new BlockList()
  const zoned = new Set<string>()
  for (const entry of entries.length ? entries : DEFAULT_TRUSTED_PROXIES) {
    const [address = "", prefix, extra] = entry.split("/")
    const family = isIP(address)
    const bits = family === 4 ? 32 : 128
    const zone = address.includes("%")
    if (
      !family ||
      extra !== undefined ||
      (prefix !== undefined && (zone || !/^\d{1,3}$/.test(prefix) || Number(prefix) > bits))
    )
      throw new Error(`N8N_OPS_TRUSTED_PROXIES: "${entry}" is not an IP address or a CIDR range`)
    const type = family === 4 ? "ipv4" : "ipv6"
    if (zone) zoned.add(address)
    else if (prefix === undefined) list.addAddress(address, type)
    else list.addSubnet(address, Number(prefix), type)
  }
  return (address) =>
    address.includes("%") ? zoned.has(address) : list.check(address, isIP(address) === 4 ? "ipv4" : "ipv6")
}

let cached: { value: string | undefined; trusts: (address: string) => boolean } | undefined

const plain = (address: string) =>
  address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address

export function addressOf(req: IncomingMessage | null) {
  const socket = req?.socket?.remoteAddress
  if (!socket || !isIP(socket)) return socket ?? "unknown"
  const value = process.env.N8N_OPS_TRUSTED_PROXIES
  if (!cached || cached.value !== value) cached = { value, trusts: trustedProxies(value) }
  if (!cached.trusts(socket)) return plain(socket)
  const forwarded = req.headers["x-forwarded-for"]
  const last = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded)?.split(",").at(-1)?.trim()
  return plain(last && isIP(last) ? last : socket)
}

export const CLIENT_ADDRESS_HEADER = "x-n8n-ops-client-address"

export function headerCount(c: Context, name: string) {
  const req = incomingOf(c)
  if (!req) return c.req.header(name) === undefined ? 0 : 1
  let n = 0
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]?.toLowerCase() === name) n++
  return n
}

export function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { at: number; n: number }>()
  let swept = Number.NEGATIVE_INFINITY
  const check = (key: string) => {
    const now = performance.now()
    if (now - swept >= 1000) {
      swept = now
      for (const [k, v] of hits) {
        if (now - v.at <= windowMs) break
        hits.delete(k)
      }
    }
    const hit = hits.get(key)
    if (!hit || now - hit.at > windowMs) {
      // Without this delete a renewed key keeps its old place, where the cleanup above stops, and ended keys pile up.
      hits.delete(key)
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
  check.firstOver = (key: string) => hits.get(key)?.n === max + 1
  check.size = () => hits.size
  return check
}

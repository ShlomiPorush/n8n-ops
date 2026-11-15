import type { IncomingMessage } from "node:http"
import { afterEach, describe, expect, it, vi } from "vitest"
import { addressOf, limiter, trustedProxies } from "./address.ts"

// The caller's address that the per-client limits count by: the socket's, or, behind a trusted proxy, the address
// the proxy appended to X-Forwarded-For.

const request = (peer: string, forwarded?: string | string[]) =>
  ({
    socket: { remoteAddress: peer },
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
  }) as unknown as IncomingMessage

const saved = process.env.N8N_OPS_TRUSTED_PROXIES
afterEach(() => {
  if (saved === undefined) delete process.env.N8N_OPS_TRUSTED_PROXIES
  else process.env.N8N_OPS_TRUSTED_PROXIES = saved
})

describe("addressOf with the built-in trusted proxies", () => {
  it("gives each client behind a reverse proxy on a private network its own address", () => {
    delete process.env.N8N_OPS_TRUSTED_PROXIES
    expect(addressOf(request("172.18.0.5", "203.0.113.7"))).toBe("203.0.113.7")
    expect(addressOf(request("172.18.0.5", "198.51.100.66"))).toBe("198.51.100.66")
    expect(addressOf(request("::ffff:10.0.3.4", "203.0.113.7"))).toBe("203.0.113.7")
    expect(addressOf(request("fd00::2", "2001:db8::7"))).toBe("2001:db8::7")
    expect(addressOf(request("127.0.0.1", "203.0.113.7"))).toBe("203.0.113.7")
  })

  it("keeps one client's limit from refusing another client behind the same proxy", () => {
    delete process.env.N8N_OPS_TRUSTED_PROXIES
    const limit = limiter(2, 600_000)
    for (let i = 0; i < 3; i++) limit(addressOf(request("172.18.0.5", "198.51.100.66")))
    expect(limit(addressOf(request("172.18.0.5", "198.51.100.66")))).toBe(false)
    expect(limit(addressOf(request("172.18.0.5", "203.0.113.7")))).toBe(true)
  })

  it("ignores X-Forwarded-For from a public peer", () => {
    delete process.env.N8N_OPS_TRUSTED_PROXIES
    expect(addressOf(request("198.51.100.1", "203.0.113.7"))).toBe("198.51.100.1")
    expect(addressOf(request("::ffff:198.51.100.1", "203.0.113.7"))).toBe("198.51.100.1")
  })

  it("takes the last forwarded address, the one the proxy appended", () => {
    delete process.env.N8N_OPS_TRUSTED_PROXIES
    expect(addressOf(request("172.18.0.5", "192.0.2.1, 203.0.113.7"))).toBe("203.0.113.7")
    expect(addressOf(request("172.18.0.5", ["192.0.2.1", "203.0.113.7"]))).toBe("203.0.113.7")
    expect(addressOf(request("172.18.0.5", "::ffff:203.0.113.7"))).toBe("203.0.113.7")
  })

  it("falls back to the peer when the last forwarded entry is not an address", () => {
    delete process.env.N8N_OPS_TRUSTED_PROXIES
    for (const forwarded of ["203.0.113.7, not-an-address", "", " ", "203.0.113.7:4000", "unknown"])
      expect(addressOf(request("172.18.0.5", forwarded))).toBe("172.18.0.5")
    expect(addressOf(request("172.18.0.5"))).toBe("172.18.0.5")
  })

  it("writes an IPv4 client on a dual-stack socket as plain IPv4", () => {
    delete process.env.N8N_OPS_TRUSTED_PROXIES
    expect(addressOf(request("::ffff:203.0.113.5"))).toBe("203.0.113.5")
  })
})

describe("N8N_OPS_TRUSTED_PROXIES", () => {
  it("replaces the built-in list with the addresses and ranges it names", () => {
    process.env.N8N_OPS_TRUSTED_PROXIES = "203.0.113.0/24, 2001:db8::1"
    expect(addressOf(request("203.0.113.9", "192.0.2.7"))).toBe("192.0.2.7")
    expect(addressOf(request("::ffff:203.0.113.9", "192.0.2.7"))).toBe("192.0.2.7")
    expect(addressOf(request("2001:db8::1", "192.0.2.7"))).toBe("192.0.2.7")
    expect(addressOf(request("172.18.0.5", "192.0.2.7"))).toBe("172.18.0.5")
  })

  it("keeps working with a single exact address", () => {
    process.env.N8N_OPS_TRUSTED_PROXIES = "172.18.0.5"
    expect(addressOf(request("172.18.0.5", "192.0.2.7"))).toBe("192.0.2.7")
    expect(addressOf(request("172.18.0.6", "192.0.2.7"))).toBe("172.18.0.6")
  })

  it("skips empty entries, and uses the built-in list when none is left", () => {
    process.env.N8N_OPS_TRUSTED_PROXIES = " 172.18.0.5 , "
    expect(addressOf(request("172.18.0.5", "192.0.2.7"))).toBe("192.0.2.7")
    expect(addressOf(request("10.0.0.2", "192.0.2.7"))).toBe("10.0.0.2")
    process.env.N8N_OPS_TRUSTED_PROXIES = " , "
    expect(addressOf(request("10.0.0.2", "192.0.2.7"))).toBe("192.0.2.7")
  })

  it("refuses an entry that is not an address or a range", () => {
    for (const value of ["nope", "10.0.0.0/33", "10.0.0.0/x", "10.0.0.0/", "fc00::/129", "10.0.0.1/8/8"])
      expect(() => trustedProxies(value)).toThrow(/N8N_OPS_TRUSTED_PROXIES/)
  })
})

describe("limiter", () => {
  afterEach(() => vi.useRealTimers())

  it("counts each key within its window and starts a new window after it", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] })
    const limit = limiter(2, 1000)
    expect([limit("a"), limit("a"), limit("a")]).toEqual([true, true, false])
    expect(limit.firstOver("a")).toBe(true)
    vi.advanceTimersByTime(1001)
    expect([limit("a"), limit("a"), limit("a")]).toEqual([true, true, false])
  })

  it("forgets keys whose window ended, however many there were", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] })
    const limit = limiter(5, 1000)
    for (let i = 0; i < 20_000; i++) limit(`k${i}`)
    expect(limit.size()).toBe(20_000)
    vi.advanceTimersByTime(500)
    limit("late")
    vi.advanceTimersByTime(501)
    limit("now")
    expect(limit.size()).toBe(2)
  })

  it("keeps windows and cleanup on their own clock when the system time moves", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] })
    const limit = limiter(1, 1000)
    expect(limit("a")).toBe(true)
    vi.setSystemTime(Date.now() - 86_400_000)
    expect(limit("a")).toBe(false)
    for (let i = 0; i < 100; i++) limit(`k${i}`)
    vi.advanceTimersByTime(1001)
    expect(limit("b")).toBe(true)
    expect(limit.size()).toBe(1)
    expect(limit("a")).toBe(true)
  })
})

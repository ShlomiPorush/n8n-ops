import { afterEach, describe, expect, it } from "vitest"
import {
  collectionClock,
  collectorAlerts,
  healthNow,
  reportsSince,
  WORKER_ONLINE_MS,
  workerOnline,
  workerSeen,
} from "./collection.ts"

const now = Date.parse("2026-10-27T12:00:00Z")
const at = (msAgo: number) => new Date(now - msAgo)
const started = collectionClock.startedAt

afterEach(() => {
  collectionClock.startedAt = started
  collectionClock.returnedAt.clear()
})

const worker = (seenAgo: number | null, extra: { revokedAt?: Date } = {}) => ({
  id: "w1",
  name: "host-a",
  lastSeenAt: seenAgo === null ? null : at(seenAgo),
  revokedAt: extra.revokedAt ?? null,
})
/** An instance checked this long ago; a check that read it is also its last known health. */
const instance = (
  checkedAgo: number | null,
  health: "ok" | "down" | "unknown" = "ok",
  healthDetail: Record<string, unknown> | null = null,
) => ({
  health,
  healthDetail,
  healthCheckedAt: checkedAgo === null ? null : at(checkedAgo),
  lastKnownHealth: health === "unknown" ? null : health,
  lastKnownAt: health === "unknown" || checkedAgo === null ? null : at(checkedAgo),
  collection: "worker" as const,
  workerId: "w1",
  setupState: "complete" as const,
  chosenCapabilities: ["health" as const],
})

describe("healthNow", () => {
  it("shows what was read before as history only when health is not chosen, or the setup is not complete", () => {
    const direct = { ...instance(10_000, "down"), collection: "direct" as const, workerId: null }
    expect(healthNow({ ...direct, chosenCapabilities: ["backup"] }, null, 60, now)).toEqual({
      health: "unknown",
      lastKnownHealth: "down",
      lastKnownAt: at(10_000),
      unknownReason: "Health is not chosen for this instance",
    })
    expect(healthNow({ ...direct, setupState: "incomplete" }, null, 60, now).unknownReason).toBe(
      "Its setup is not complete",
    )
  })

  // The server has run for a day: only the worker decides.
  const settled = () => {
    collectionClock.startedAt = at(86_400_000)
  }

  it("keeps the stored health while the worker collects it", () => {
    settled()
    expect(healthNow(instance(10_000), worker(5_000), 60, now)).toEqual({
      health: "ok",
      lastKnownHealth: null,
      lastKnownAt: null,
      unknownReason: null,
    })
  })

  it("never changes direct collection", () => {
    const direct = { ...instance(86_400_000, "down"), collection: "direct" as const, workerId: null }
    expect(healthNow(direct, null, 60, now).health).toBe("down")
  })

  it("is unknown when no worker is assigned, or it was revoked", () => {
    settled()
    expect(healthNow({ ...instance(10_000), workerId: null }, null, 60, now)).toEqual({
      health: "unknown",
      lastKnownHealth: "ok",
      lastKnownAt: at(10_000),
      unknownReason: "No worker is assigned",
    })
    const revoked = healthNow(instance(10_000), worker(5_000, { revokedAt: at(1_000) }), 60, now)
    expect(revoked.unknownReason).toBe("No worker is assigned")
  })

  it("is unknown once the worker is offline, with the last known health", () => {
    settled()
    expect(healthNow(instance(10_000, "down"), worker(WORKER_ONLINE_MS - 1), 60, now).health).toBe("down")
    expect(healthNow(instance(10_000, "down"), worker(WORKER_ONLINE_MS), 60, now)).toEqual({
      health: "unknown",
      lastKnownHealth: "down",
      lastKnownAt: at(10_000),
      unknownReason: "host-a is offline",
    })
  })

  it("has no last known health when it was never read", () => {
    settled()
    expect(healthNow(instance(null, "unknown"), worker(null), 60, now)).toEqual({
      health: "unknown",
      lastKnownHealth: null,
      lastKnownAt: null,
      unknownReason: "host-a is offline",
    })
    // Online and not read yet: simply not checked yet.
    expect(healthNow(instance(null, "unknown"), worker(1_000), 60, now).unknownReason).toBeNull()
  })

  it("is unknown when an online worker stops reporting checks, by the instance's own interval", () => {
    settled()
    const due = 60_000 + WORKER_ONLINE_MS
    expect(healthNow(instance(due - 1), worker(1_000), 60, now).health).toBe("ok")
    expect(healthNow(instance(due), worker(1_000), 60, now).unknownReason).toBe(
      "host-a has not reported a check in time",
    )
    // The same reading, for an instance checked once an hour, is still current.
    expect(healthNow(instance(due), worker(1_000), 3600, now).health).toBe("ok")
  })

  it("waits for a new check after the worker came back, or after this server started", () => {
    collectionClock.startedAt = at(30_000)
    expect(healthNow(instance(60_000), worker(1_000), 3600, now).unknownReason).toBe(
      "Waiting for a new check by host-a",
    )
    expect(healthNow(instance(10_000), worker(1_000), 3600, now).health).toBe("ok")

    settled()
    collectionClock.returnedAt.set("w1", at(5_000))
    expect(healthNow(instance(10_000), worker(1_000), 3600, now).health).toBe("unknown")
    expect(healthNow(instance(4_000), worker(1_000), 3600, now).health).toBe("ok")
  })
})

describe("healthNow after a check that was not collected", () => {
  it("says why, with the last check that read the instance", () => {
    collectionClock.startedAt = at(86_400_000)
    const notCollected = {
      ...instance(10_000, "unknown", { notCollected: "docker exec failed" }),
      lastKnownHealth: "ok" as const,
      lastKnownAt: at(600_000),
    }
    expect(healthNow(notCollected, worker(1_000), 60, now)).toEqual({
      health: "unknown",
      lastKnownHealth: "ok",
      lastKnownAt: at(600_000),
      unknownReason: "Not collected: docker exec failed",
    })
    // Its worker offline afterwards: still the same last known health.
    expect(healthNow(notCollected, worker(WORKER_ONLINE_MS), 60, now)).toMatchObject({
      lastKnownHealth: "ok",
      unknownReason: "host-a is offline",
    })
  })
})

describe("workerSeen", () => {
  it("marks a return only for a worker that was offline", () => {
    collectionClock.startedAt = at(86_400_000)
    workerSeen(worker(1_000), new Date(now))
    expect(reportsSince("w1")).toEqual(collectionClock.startedAt)
    workerSeen(worker(WORKER_ONLINE_MS), new Date(now))
    expect(reportsSince("w1")).toEqual(new Date(now))
    expect(workerOnline(worker(WORKER_ONLINE_MS), now)).toBe(false)
  })
})

describe("the worker alerts", () => {
  it("name the worker and its instances, escaped and bounded", () => {
    expect(String(collectorAlerts.lost("host <a>", ["alpha", "b&c"]))).toBe(
      "<b>Worker host &lt;a&gt; stopped reporting</b>\nHealth of alpha, b&amp;c is unknown until it reports again",
    )
    expect(String(collectorAlerts.back("host-a", ["alpha"]))).toBe(
      "<b>Worker host-a is back online</b>\nHealth of alpha is checked again with its next report",
    )
    const many = Array.from({ length: 80 }, (_, i) => `${"n".repeat(70)}${i}`)
    const text = String(collectorAlerts.lost("w".repeat(200), many))
    expect(text).toContain(" and 70 more is unknown")
    expect(text.length).toBeLessThan(1000)
  })
})

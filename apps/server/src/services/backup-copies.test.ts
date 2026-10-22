import { describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import type { backupCopies } from "../db/schema.ts"
import { clearLeftovers } from "./backup-copies.ts"
import type { Store } from "./destinations/store.ts"

type Copy = typeof backupCopies.$inferSelect

/** A store that records removals and refuses those of the versions listed as locked. */
function fakeStore(locked: string[] = []) {
  const removed: (string | null)[] = []
  const store = {
    remove: async (_key: string, _signal: AbortSignal, versionId?: string | null) => {
      if (versionId && locked.includes(versionId)) throw new Error("AccessDenied: object is locked")
      removed.push(versionId ?? null)
    },
  } as unknown as Store
  return { store, removed }
}

/** A database that keeps the last update of the copy's leftovers. */
function fakeCtx() {
  const saved: { leftovers?: unknown } = {}
  const ctx = {
    db: { update: () => ({ set: (v: { leftovers: unknown }) => ({ where: async () => Object.assign(saved, v) }) }) },
    log: { warn: () => {}, info: () => {}, error: () => {} },
  } as unknown as Ctx
  return { ctx, saved }
}

const now = new Date("2026-10-22T12:00:00Z")
const copy = (status: Copy["status"], leftovers: Copy["leftovers"]) =>
  ({ id: "c", objectKey: "prod/a.age", status, deletedAt: null, leftovers }) as unknown as Copy

describe("clearLeftovers", () => {
  it("removes versions whose lock has ended, keeps those still locked", async () => {
    const { store, removed } = fakeStore()
    const { ctx, saved } = fakeCtx()
    const left = await clearLeftovers(
      ctx,
      copy("failed", [
        { versionId: "v1", retainUntil: "2026-10-01T00:00:00Z" },
        { versionId: "v2", retainUntil: "2026-11-01T00:00:00Z" },
        { versionId: "v3", retainUntil: null },
      ]),
      store,
      now,
    )
    expect(removed).toEqual(["v1", "v3"])
    expect(left).toEqual([{ versionId: "v2", retainUntil: "2026-11-01T00:00:00Z" }])
    expect(saved.leftovers).toEqual(left)
  })

  it("keeps listing what the service still refuses to remove", async () => {
    const { store } = fakeStore(["v1"])
    const { ctx } = fakeCtx()
    const left = await clearLeftovers(ctx, copy("failed", [{ versionId: "v1", retainUntil: null }]), store, now)
    expect(left).toHaveLength(1)
  })

  it("never removes the object a copy holds, and removes it once the copy has failed", async () => {
    const held = fakeStore()
    expect(
      await clearLeftovers(fakeCtx().ctx, copy("ok", [{ versionId: null, retainUntil: null }]), held.store, now),
    ).toEqual([])
    expect(held.removed).toEqual([])
    const failed = fakeStore()
    await clearLeftovers(fakeCtx().ctx, copy("failed", [{ versionId: null, retainUntil: null }]), failed.store, now)
    expect(failed.removed).toEqual([null])
  })
})

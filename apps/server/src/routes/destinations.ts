import { and, count, desc, eq, isNull, max } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { backupCopies, backupDestinations, type DestinationKind, instances } from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import { dropConditions } from "../services/backup-copies.ts"
import {
  credentialFields,
  type Destination,
  defaultRetention,
  destinationKinds,
  destinationView,
  locationSchemas,
  missingCredentials,
  objectLockSchema,
  openStore,
  placeOf,
  placesOverlap,
  retentionSchema,
  sameLock,
} from "../services/destinations/index.ts"
import { fetchHostKey } from "../services/destinations/sftp.ts"
import { withDeadline } from "../services/destinations/store.ts"

const TEST_MS = 60_000

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(destinationKinds),
  location: z.record(z.string(), z.unknown()),
  credentials: z.record(z.string(), z.unknown()).default({}),
  retention: retentionSchema.default(defaultRetention),
  objectLock: objectLockSchema.default(null),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
})
const updateSchema = createSchema.omit({ kind: true }).partial()

type Fail = { status: 400 | 404 | 409; error: string; message: string; issues?: unknown }
const fail = (status: Fail["status"], message: string, issues?: unknown): Fail => ({
  status,
  error: status === 404 ? "not_found" : status === 409 ? "conflict" : "invalid",
  message,
  issues,
})

/** Whether two flat objects hold the same values; PostgreSQL stores JSON keys in an order of its own. */
const sameFields = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].every((k) => a[k] === b[k])

/** Stored credentials: plain fields as given, secrets encrypted; a secret left out stays, null removes it. */
function mergeCredentials(
  ctx: Ctx,
  kind: DestinationKind,
  current: Record<string, unknown>,
  body: Record<string, unknown>,
) {
  const next: Record<string, unknown> = {}
  const fields = credentialFields[kind]
  for (const f of fields.plain) {
    const v = body[f] ?? current[f]
    if (typeof v === "string" && v.trim()) next[f] = v.trim()
  }
  for (const f of fields.secret) {
    const v = body[f]
    if (typeof v === "string" && v.length > 0)
      next[`${f}Enc`] = ctx.secrets.encrypt(f === "privateKey" ? `${v.trim()}\n` : v)
    else if (v !== null && current[`${f}Enc`]) next[`${f}Enc`] = current[`${f}Enc`]
  }
  return next
}

/** Runs the destination's test on settings that may not be stored yet. */
async function testDestination(ctx: Ctx, d: Pick<Destination, "kind" | "location" | "credentials" | "objectLock">) {
  const store = openStore(ctx, d)
  try {
    return await withDeadline(TEST_MS, "The test", (signal) => store.test(signal))
  } finally {
    await store.close().catch(() => {})
  }
}

/** Backup destinations: Settings > Backup Destinations, and the choice on each instance. */
export function destinationRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))

  app.get("/", async (c) => {
    const rows = await ctx.db.select().from(backupDestinations).orderBy(backupDestinations.name)
    const stats = await ctx.db
      .select({ id: backupCopies.destinationId, copies: count(), lastOk: max(backupCopies.finishedAt) })
      .from(backupCopies)
      .where(and(eq(backupCopies.status, "ok"), isNull(backupCopies.deletedAt)))
      .groupBy(backupCopies.destinationId)
    const lastFailures = await ctx.db
      .select({ id: backupCopies.destinationId, error: backupCopies.error, at: backupCopies.finishedAt })
      .from(backupCopies)
      .where(eq(backupCopies.status, "failed"))
      .orderBy(desc(backupCopies.finishedAt))
      .limit(200)
    return c.json(
      rows.map((d) => {
        const s = stats.find((x) => x.id === d.id)
        const lastFailure = lastFailures.find((f) => f.id === d.id) ?? null
        return { ...destinationView(d), copies: s?.copies ?? 0, lastOkAt: s?.lastOk ?? null, lastFailure }
      }),
    )
  })

  /** The SFTP server's host key fingerprint, to pin. Asked before any credential is sent. */
  app.post("/host-key", async (c) => {
    const body = z
      .object({ host: z.string().trim().min(1).max(255), port: z.number().int().min(1).max(65535).default(22) })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid", issues: body.error.issues }, 400)
    try {
      return c.json({ hostKey: await fetchHostKey(body.data.host, body.data.port, AbortSignal.timeout(20_000)) })
    } catch (error) {
      return c.json({ error: "invalid", message: `Could not read the host key: ${(error as Error).message}` }, 400)
    }
  })

  /** Checks a destination and stores it only when its test passes. */
  async function prepare(
    body: z.infer<typeof updateSchema> & { kind: DestinationKind },
    current: Destination | null,
  ): Promise<Fail | { row: Omit<Destination, "id" | "createdAt" | "updatedAt">; tested: boolean; notes: string[] }> {
    const kind = body.kind
    // A fixed place is kept exactly as stored, even one an earlier version allowed and today's rules would not
    // (a key prefix with a space), so turning it off or replacing its keys always works.
    const lockedLocation = current?.lockedAt ? current.location : null
    let location: Record<string, unknown>
    if (lockedLocation) {
      if (body.location && !sameFields(body.location, lockedLocation)) {
        const asNew = locationSchemas[kind].safeParse(body.location)
        if (!asNew.success || !sameFields(asNew.data, lockedLocation))
          return fail(400, "Where archives go cannot change once set; add a new destination for a new place.")
      }
      location = lockedLocation
    } else {
      const parsedLocation = locationSchemas[kind].safeParse(body.location ?? current?.location ?? {})
      if (!parsedLocation.success)
        return fail(
          400,
          "Check the destination's settings.",
          parsedLocation.error.issues.map((i) => ({ ...i, path: ["location", ...i.path] })),
        )
      location = parsedLocation.data as Record<string, unknown>
    }
    const objectLock = body.objectLock !== undefined ? body.objectLock : (current?.objectLock ?? null)
    if (objectLock && kind !== "s3") return fail(400, "Object Lock is only for S3 destinations.")
    const credentials = mergeCredentials(ctx, kind, current?.credentials ?? {}, body.credentials ?? {})
    const missing = missingCredentials(kind, credentials)
    if (missing) return fail(400, `Enter ${missing}.`)

    const name = body.name ?? current?.name ?? ""
    const others = (await ctx.db.select().from(backupDestinations)).filter((d) => d.id !== current?.id)
    if (others.some((d) => d.name.toLowerCase() === name.toLowerCase()))
      return fail(400, "Another destination has this name.", [{ path: ["name"], message: "already used" }])
    if (!lockedLocation) {
      const place = placeOf(kind, location)
      const clash = others.find((d) => {
        try {
          return placesOverlap(place, placeOf(d.kind, d.location))
        } catch {
          return false
        }
      })
      if (clash)
        return fail(
          400,
          `This place is already used by the destination "${clash.name}", or one holds the other. Each destination needs a place of its own, so retention never removes another one's archives.`,
        )
    }

    // A change to where, how or with what it connects is tested before it is stored.
    const touches =
      !current?.lockedAt ||
      body.credentials !== undefined ||
      (body.objectLock !== undefined && !sameLock(body.objectLock, current.objectLock))
    let notes: string[] = []
    if (touches) {
      try {
        notes = await testDestination(ctx, { kind, location, credentials, objectLock })
      } catch (error) {
        return fail(400, `The destination test failed: ${(error as Error).message}`)
      }
    }
    return {
      tested: touches,
      notes,
      row: {
        name,
        kind,
        location,
        credentials,
        objectLock,
        retention: body.retention ?? current?.retention ?? defaultRetention,
        enabled: body.enabled ?? current?.enabled ?? true,
        isDefault: body.isDefault ?? current?.isDefault ?? false,
        lockedAt: current?.lockedAt ?? new Date(),
      },
    }
  }

  app.post("/", async (c) => {
    const body = createSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid", issues: body.error.issues }, 400)
    const prepared = await prepare(body.data, null)
    if ("status" in prepared) return c.json(prepared, prepared.status)
    const [row] = await ctx.db.insert(backupDestinations).values(prepared.row).returning()
    if (!row) return c.json({ error: "internal_error" }, 500)
    await ctx.audit({
      actor: actorName(c.get("actor")),
      action: "Backup destination added",
      target: row.name,
      via: "web",
      details: { kind: row.kind, default: row.isDefault, objectLock: row.objectLock },
    })
    return c.json({ ...destinationView(row), notes: prepared.notes })
  })

  app.patch("/:id", async (c) => {
    const [current] = await ctx.db
      .select()
      .from(backupDestinations)
      .where(eq(backupDestinations.id, c.req.param("id")))
    if (!current) return c.json({ error: "not_found" }, 404)
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const body = updateSchema.safeParse(raw)
    if (!body.success) return c.json({ error: "invalid", issues: body.error.issues }, 400)
    const prepared = await prepare({ ...body.data, kind: current.kind }, current)
    if ("status" in prepared) return c.json(prepared, prepared.status)
    const [row] = await ctx.db
      .update(backupDestinations)
      .set({ ...prepared.row, updatedAt: new Date() })
      .where(eq(backupDestinations.id, current.id))
      .returning()
    if (!row) return c.json({ error: "internal_error" }, 500)
    if (!row.enabled && current.enabled) {
      // Its stale alerts end with it; its archives stay, restorable and expiring as before.
      const keys = (await ctx.db.select({ id: instances.id }).from(instances)).map((i) => `backup:${i.id}:${row.id}`)
      await dropConditions(ctx, [...keys, `backup:self:${row.id}`])
    }
    await ctx.audit({
      actor: actorName(c.get("actor")),
      action: "Backup destination changed",
      target: row.name,
      via: "web",
      details: {
        fields: Object.keys(raw).filter((k) => k !== "credentials"),
        credentialsChanged: Object.keys((raw.credentials as Record<string, unknown> | undefined) ?? {}),
        tested: prepared.tested,
      },
    })
    return c.json({ ...destinationView(row), notes: prepared.notes })
  })

  app.post("/:id/test", async (c) => {
    const [d] = await ctx.db
      .select()
      .from(backupDestinations)
      .where(eq(backupDestinations.id, c.req.param("id")))
    if (!d) return c.json({ error: "not_found" }, 404)
    try {
      const notes = await testDestination(ctx, d)
      return c.json({ ok: true, notes })
    } catch (error) {
      return c.json({ error: "invalid", message: `The destination test failed: ${(error as Error).message}` }, 400)
    }
  })

  /**
   * Removes a destination. With files "delete" its archives go too (refused while an Object Lock holds any);
   * with "keep" they stay where they are, and n8n-ops forgets them.
   */
  app.delete("/:id", async (c) => {
    const files = z.enum(["delete", "keep"]).safeParse(c.req.query("files"))
    if (!files.success) return c.json({ error: "invalid", message: "Say whether to delete or keep its archives." }, 400)
    const [d] = await ctx.db
      .select()
      .from(backupDestinations)
      .where(eq(backupDestinations.id, c.req.param("id")))
    if (!d) return c.json({ error: "not_found" }, 404)
    const copies = await ctx.db.select().from(backupCopies).where(eq(backupCopies.destinationId, d.id))
    if (copies.some((x) => x.status === "pending" || x.status === "writing"))
      return c.json(
        { error: "conflict", message: "A backup is writing to this destination. Try again when it ends." },
        409,
      )
    const live = copies.filter((x) => x.status === "ok" && !x.deletedAt)
    if (files.data === "delete") {
      // Everything written there goes: kept archives, what failed copies left, and versions listed for removal.
      const objects = copies.flatMap((x) => [
        ...((x.status === "ok" && !x.deletedAt) || x.status === "failed"
          ? [{ key: x.objectKey, versionId: x.versionId, until: x.status === "ok" ? x.retainUntil : null }]
          : []),
        ...x.leftovers.map((l) => ({
          key: x.objectKey,
          versionId: l.versionId,
          until: l.retainUntil ? new Date(l.retainUntil) : null,
        })),
      ])
      const now = new Date()
      const locked = objects.filter((o) => o.until && o.until > now)
      if (locked.length) {
        const until = locked.reduce((a, b) => ((a.until ?? 0) > (b.until ?? 0) ? a : b)).until
        return c.json(
          {
            error: "conflict",
            message: `${locked.length} archives are under Object Lock until ${until?.toISOString().slice(0, 10)} and cannot be deleted. Turn the destination off, or keep its archives.`,
          },
          409,
        )
      }
      const store = openStore(ctx, d)
      try {
        for (const o of objects)
          await withDeadline(5 * 60_000, "Deleting an archive", (s) => store.remove(o.key, s, o.versionId))
        if (d.kind !== "s3")
          for (const x of copies.filter((c) => c.status === "failed"))
            await withDeadline(60_000, "Deleting a temporary file", (s) =>
              store.remove(`${x.objectKey}.part`, s),
            ).catch(() => {})
      } catch (error) {
        return c.json(
          {
            error: "invalid",
            message: `Could not delete the archives: ${(error as Error).message}. Nothing was removed from n8n-ops.`,
          },
          400,
        )
      } finally {
        await store.close().catch(() => {})
      }
    }
    await ctx.db.transaction(async (tx) => {
      await tx.delete(backupCopies).where(eq(backupCopies.destinationId, d.id))
      await tx.delete(backupDestinations).where(eq(backupDestinations.id, d.id))
    })
    const keys = (await ctx.db.select({ id: instances.id }).from(instances)).map((i) => `backup:${i.id}:${d.id}`)
    await dropConditions(ctx, [...keys, `backup:self:${d.id}`])
    // Runs left without any copy keep their history; restoring them is no longer possible.
    await ctx.audit({
      actor: actorName(c.get("actor")),
      action: "Backup destination deleted",
      target: d.name,
      via: "web",
      details: { kind: d.kind, archives: live.length, files: files.data },
    })
    return c.json({ ok: true })
  })

  return app
}

import { and, eq, inArray } from "drizzle-orm"
import { z } from "zod"
import type { Ctx } from "../../context.ts"
import {
  backupDestinations,
  type DestinationKind,
  instanceBackupDestinations,
  type instances,
  type ObjectLock,
  type RetentionPolicy,
} from "../../db/schema.ts"
import { localStore } from "./local.ts"
import { s3Store } from "./s3.ts"
import { sftpStore } from "./sftp.ts"
import { cleanFolder, type Store, StoreError } from "./store.ts"
import { webdavBase, webdavStore } from "./webdav.ts"

export type Destination = typeof backupDestinations.$inferSelect
type Instance = typeof instances.$inferSelect

export const destinationKinds = ["s3", "local", "sftp", "webdav"] as const

const text = (max = 500) => z.string().trim().max(max)
const folder = text(300).transform((v, c) => {
  try {
    return cleanFolder(v)
  } catch {
    c.addIssue({ code: "custom", message: "letters, digits, dot, dash and underscore in each folder name" })
    return z.NEVER
  }
})

/** Where each kind keeps archives. These fields never change once the destination is created. */
export const locationSchemas = {
  s3: z.object({
    endpoint: z.union([z.literal(""), z.string().trim().url()]),
    region: text(60),
    bucket: text(255).min(3, "the bucket name"),
    prefix: folder,
    forcePathStyle: z.boolean(),
  }),
  local: z.object({ folder }),
  sftp: z.object({
    host: text(255).min(1, "the host"),
    port: z.number().int().min(1).max(65535),
    username: text(128).min(1, "the user name"),
    path: text(500).min(1, "the folder on the server"),
  }),
  webdav: z.object({
    url: text(1000).refine((v) => {
      try {
        webdavBase(v)
        return true
      } catch {
        return false
      }
    }, "an https:// URL of a folder on the WebDAV server"),
    username: text(128).min(1, "the user name"),
  }),
} satisfies Record<DestinationKind, z.ZodType>

/** Plain credential fields; secrets are written plain and stored as <name>Enc. */
export const credentialFields: Record<DestinationKind, { plain: string[]; secret: string[] }> = {
  s3: { plain: ["accessKeyId"], secret: ["secretAccessKey"] },
  local: { plain: [], secret: [] },
  sftp: { plain: ["hostKey"], secret: ["password", "privateKey", "passphrase"] },
  webdav: { plain: [], secret: ["password"] },
}

export const retentionSchema = z.object({
  daily: z.number().int().min(1).max(365),
  weekly: z.number().int().min(0).max(260),
  monthly: z.number().int().min(0).max(240),
})

export const objectLockSchema = z
  .object({ mode: z.enum(["COMPLIANCE", "GOVERNANCE"]), days: z.number().int().min(1).max(3650) })
  .nullable()

export const defaultRetention: RetentionPolicy = { daily: 7, weekly: 4, monthly: 6 }

/** Whether two Object Lock settings are the same, whatever order their fields were stored in. */
export const sameLock = (a: ObjectLock | null | undefined, b: ObjectLock | null | undefined) =>
  (a?.mode ?? null) === (b?.mode ?? null) && (a?.days ?? null) === (b?.days ?? null)

/** A destination as the UI sees it: secrets only as "set" flags, never their ciphertext. */
export function destinationView(d: Destination) {
  const { credentials, ...rest } = d
  const view: Record<string, unknown> = {}
  for (const f of credentialFields[d.kind].plain) view[f] = credentials[f] ?? ""
  for (const f of credentialFields[d.kind].secret) view[`${f}Set`] = Boolean(credentials[`${f}Enc`])
  return { ...rest, credentials: view, where: describeLocation(d) }
}

/** One line that says where the archives are. */
export function describeLocation(d: Pick<Destination, "kind" | "location">) {
  const l = d.location as Record<string, string | number | boolean>
  switch (d.kind) {
    case "s3":
      return `s3://${l.bucket}${l.prefix ? `/${l.prefix}` : ""}${l.endpoint ? ` at ${new URL(String(l.endpoint)).host}` : ""}`
    case "local":
      return `/backups${l.folder ? `/${l.folder}` : ""}`
    case "sftp":
      return `sftp://${l.username}@${l.host}${l.port === 22 ? "" : `:${l.port}`}${String(l.path).startsWith("/") ? "" : "/"}${l.path}`
    case "webdav":
      return `${l.url} as ${l.username}`
  }
}

/**
 * A comparable form of the place archives land: two destinations whose places are equal, or where one holds
 * the other, would write into and expire each other's folders, so a new one like that is refused.
 */
export function placeOf(kind: DestinationKind, location: Record<string, unknown>): string {
  const l = location as Record<string, string>
  const path = (p: string) => p.replace(/^\/+|\/+$/g, "")
  switch (kind) {
    case "s3":
      return `s3|${(l.endpoint ? new URL(l.endpoint).host : "aws").toLowerCase()}|${l.bucket}|${path(l.prefix ?? "")}`
    case "local":
      return `local|||${path(l.folder ?? "")}`
    case "sftp":
      return `sftp|${String(l.host).toLowerCase()}:${l.port}|${l.username}|${path(l.path ?? "")}`
    case "webdav": {
      const url = webdavBase(l.url ?? "")
      return `webdav|${url.host.toLowerCase()}|${l.username}|${path(decodeURIComponent(url.pathname))}`
    }
  }
}

export function placesOverlap(a: string, b: string) {
  const [ka, ha, ua, pa = ""] = a.split("|")
  const [kb, hb, ub, pb = ""] = b.split("|")
  // The third part is the bucket for S3 and the account for SFTP and WebDAV, where it decides the place.
  if (ka !== kb || ha !== hb || ua !== ub) return false
  return pa === pb || pa === "" || pb === "" || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`)
}

/** The key of a new archive on this destination: under the S3 key prefix, or as given elsewhere. */
export function keyFor(d: Pick<Destination, "kind" | "location">, parts: string[]) {
  const prefix =
    d.kind === "s3" ? String((d.location as { prefix?: string }).prefix ?? "").replace(/^\/+|\/+$/g, "") : ""
  return [prefix, ...parts].filter(Boolean).join("/")
}

/** Opens the destination with its decrypted credentials. Close the store when done. */
export function openStore(
  ctx: Pick<Ctx, "secrets">,
  d: Pick<Destination, "kind" | "location" | "credentials" | "objectLock">,
): Store {
  const c = d.credentials as Record<string, string | undefined>
  const secret = (name: string) => (c[`${name}Enc`] ? ctx.secrets.decrypt(c[`${name}Enc`] as string) : undefined)
  const l = d.location as never
  switch (d.kind) {
    case "s3":
      return s3Store(
        l,
        { accessKeyId: c.accessKeyId ?? "", secretAccessKey: secret("secretAccessKey") ?? "" },
        d.objectLock,
      )
    case "local":
      return localStore(l)
    case "sftp":
      return sftpStore(l, {
        hostKey: c.hostKey ?? "",
        password: secret("password"),
        privateKey: secret("privateKey"),
        passphrase: secret("passphrase"),
      })
    case "webdav":
      return webdavStore(l, { password: secret("password") ?? "" })
  }
}

/** Whether the credentials are complete enough to try. */
export function missingCredentials(kind: DestinationKind, credentials: Record<string, unknown>): string | null {
  const has = (f: string) => Boolean(credentials[f] || credentials[`${f}Enc`])
  switch (kind) {
    case "s3":
      return has("accessKeyId") && has("secretAccessKey") ? null : "the access key ID and the secret access key"
    case "local":
      return null
    case "sftp":
      if (!has("hostKey")) return "the server's host key fingerprint"
      return has("password") || has("privateKey") ? null : "a password or a private key"
    case "webdav":
      return has("password") ? null : "the password"
  }
}

/** Retention is the newest daily, weekly and monthly archive; an Object Lock only applies to S3. */
export function checkObjectLock(kind: DestinationKind, lock: ObjectLock | null) {
  if (lock && kind !== "s3") throw new StoreError("Object Lock is only for S3 destinations")
}

/**
 * The destinations a backup of this instance (or of n8n-ops itself, with null) writes to now: enabled ones,
 * either the defaults or those chosen.
 */
export async function destinationsFor(ctx: Ctx, instance: Pick<Instance, "id" | "backupDestinations"> | null) {
  let mode: "default" | "custom"
  let ids: string[] = []
  if (instance) {
    mode = instance.backupDestinations
    if (mode === "custom")
      ids = (
        await ctx.db
          .select({ id: instanceBackupDestinations.destinationId })
          .from(instanceBackupDestinations)
          .where(eq(instanceBackupDestinations.instanceId, instance.id))
      ).map((r) => r.id)
  } else {
    const s = await ctx.settings.get("backups")
    mode = s.selfDestinations
    ids = s.selfDestinationIds
  }
  if (mode === "default")
    return ctx.db
      .select()
      .from(backupDestinations)
      .where(and(eq(backupDestinations.enabled, true), eq(backupDestinations.isDefault, true)))
  if (!ids.length) return []
  return ctx.db
    .select()
    .from(backupDestinations)
    .where(and(eq(backupDestinations.enabled, true), inArray(backupDestinations.id, ids)))
}

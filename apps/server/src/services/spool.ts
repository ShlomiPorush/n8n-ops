import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { Ctx } from "../context.ts"

/**
 * Encrypted archives wait here, under the server's data directory, until every destination has its copy.
 * Space is reserved before a write starts, so two archives arriving together cannot both take the last of it.
 */
export const KEEP_FREE = 1024 ** 3

export const spoolDir = (ctx: Pick<Ctx, "appKeyPath">) => join(dirname(ctx.appKeyPath), "spool")
export const spoolFile = (dir: string, runId: string) => join(dir, `${runId}.age`)

export class SpoolError extends Error {}

const reserved = new Map<string, number>()

async function freeSpace(dir: string) {
  const fs = await statfs(dir)
  return fs.bavail * fs.bsize
}

/** Holds room for an archive of this size; release it when the write ends, whatever the outcome. */
export async function reserve(
  dir: string,
  size: number,
  { free: measure = freeSpace }: { free?: (dir: string) => Promise<number> } = {},
) {
  await mkdir(dir, { recursive: true })
  const free = await measure(dir)
  // Checked and taken without an await in between, so concurrent callers see each other's reservations.
  const held = reserved.get(dir) ?? 0
  if (free - held - size < KEEP_FREE)
    throw new SpoolError(
      `Not enough free space in the data directory for a ${Math.ceil(size / 1024 ** 2)} MiB archive (1 GiB is always kept free).`,
    )
  reserved.set(dir, held + size)
  let released = false
  return () => {
    if (released) return
    released = true
    reserved.set(dir, (reserved.get(dir) ?? 0) - size)
  }
}

/**
 * Writes an archive to the spool through a temporary name, counting bytes and computing SHA-256 on the way.
 * More bytes than `limit` end the write. Returns the size and checksum of what was written.
 */
export async function writeSpool(
  dir: string,
  runId: string,
  source: Readable | Uint8Array,
  { limit, signal }: { limit: number; signal?: AbortSignal },
) {
  await mkdir(dir, { recursive: true })
  const target = spoolFile(dir, runId)
  const part = `${target}.part`
  const hash = createHash("sha256")
  let size = 0
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length
      if (size > limit) return done(new SpoolError(`the archive is larger than ${limit} bytes`))
      hash.update(chunk)
      done(null, chunk)
    },
  })
  const input = source instanceof Uint8Array ? Readable.from([Buffer.from(source)]) : source
  try {
    await pipeline(input, count, createWriteStream(part, { mode: 0o600 }), ...(signal ? [{ signal }] : []))
    await rename(part, target)
  } catch (error) {
    await rm(part, { force: true })
    throw error
  }
  return { file: target, size, sha256: hash.digest("base64") }
}

export async function spoolExists(dir: string, runId: string) {
  return stat(spoolFile(dir, runId))
    .then((s) => s.isFile())
    .catch(() => false)
}

export async function removeSpool(dir: string, runId: string) {
  await rm(spoolFile(dir, runId), { force: true })
  await rm(`${spoolFile(dir, runId)}.part`, { force: true })
}

/** Run IDs that have a file in the spool, complete or not. */
export async function spooledRuns(dir: string) {
  const names = await readdir(dir).catch(() => [] as string[])
  return [...new Set(names.filter((n) => /\.age(\.part)?$/.test(n)).map((n) => n.replace(/\.age(\.part)?$/, "")))]
}

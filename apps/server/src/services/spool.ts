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
export const MAX_UPLOADS = 4
export const UPLOAD_SLOT_WAIT_MS = 4 * 60_000

export const spoolDir = (ctx: Pick<Ctx, "appKeyPath">) => join(dirname(ctx.appKeyPath), "spool")
export const spoolFile = (dir: string, runId: string) => join(dir, `${runId}.age`)

export class SpoolError extends Error {}

type Budget = { reserved: number; uploads: number }
const budgets = new Map<string, Budget>()

async function freeSpace(dir: string) {
  const fs = await statfs(dir)
  return fs.bavail * fs.bsize
}

/** Holds room for an archive of this size; release it when the write ends, whatever the outcome. */
export async function reserve(
  dir: string,
  size: number,
  {
    upload = false,
    free: measure = freeSpace,
    waitMs = UPLOAD_SLOT_WAIT_MS,
  }: { upload?: boolean; free?: (dir: string) => Promise<number>; waitMs?: number } = {},
) {
  await mkdir(dir, { recursive: true })
  const budget = budgets.get(dir) ?? { reserved: 0, uploads: 0 }
  budgets.set(dir, budget)
  // Many instances back up at the same time of night: an upload waits its turn rather than fail.
  const until = Date.now() + waitMs
  for (;;) {
    const free = await measure(dir)
    if (upload && budget.uploads >= MAX_UPLOADS) {
      if (Date.now() >= until)
        throw new SpoolError(`${MAX_UPLOADS} archives were being received for too long; the next backup tries again.`)
      await new Promise((r) => setTimeout(r, 1_000))
      continue
    }
    return take(budget, free, size, upload)
  }
}

function take(budget: Budget, free: number, size: number, upload: boolean) {
  // Checked and taken without an await in between, so concurrent callers see each other's reservations.
  if (free - budget.reserved - size < KEEP_FREE)
    throw new SpoolError(
      `Not enough free space in the data directory for a ${Math.ceil(size / 1024 ** 2)} MiB archive (1 GiB is always kept free).`,
    )
  budget.reserved += size
  if (upload) budget.uploads += 1
  let released = false
  return () => {
    if (released) return
    released = true
    budget.reserved -= size
    if (upload) budget.uploads -= 1
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

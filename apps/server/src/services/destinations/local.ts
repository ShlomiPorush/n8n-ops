import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, open, readFile, realpath, rename, rm, statfs } from "node:fs/promises"
import { dirname, join, sep } from "node:path"
import { pipeline } from "node:stream/promises"
import { checkKey, roundTrip, type Store, StoreError, verifyByReading } from "./store.ts"

/** The folder mapped into the server container for local backups. */
export const BACKUPS_DIR = process.env.BACKUPS_DIR || "/backups"

export type LocalLocation = { folder: string }

/** Whether the path is a mount point, from the kernel's mount table (a bind mount can share the device). */
export async function isMountPoint(path: string, mountinfo = "/proc/self/mountinfo"): Promise<boolean> {
  try {
    const target = await realpath(path)
    const table = await readFile(mountinfo, "utf8")
    // Field 5 is the mount point, with spaces and similar written as octal escapes.
    return table
      .split("\n")
      .map((line) =>
        line.split(" ")[4]?.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(Number.parseInt(o, 8))),
      )
      .some((point) => point === target)
  } catch {
    return false
  }
}

const notMapped = () =>
  new StoreError(
    `${BACKUPS_DIR} is not mapped to a folder on the host, so archives would vanish with the container. Add it to the server's volumes in docker-compose.yml, for example ./backups:${BACKUPS_DIR}.`,
  )

/**
 * Archives under /backups/<folder>. Every path is resolved and must stay inside that folder, also through
 * symbolic links.
 */
export function localStore(location: LocalLocation, options: { root?: string; requireMount?: boolean } = {}): Store {
  const base = options.root ?? BACKUPS_DIR
  const requireMount = options.requireMount ?? true
  const top = location.folder ? join(base, ...checkKey(location.folder)) : base

  async function ready() {
    if (requireMount && !(await isMountPoint(base))) throw notMapped()
    await mkdir(top, { recursive: true })
    return realpath(top)
  }

  /** The archive's path; its folder is created and checked to be inside the destination. */
  async function place(key: string, create: boolean) {
    const root = await ready()
    const file = join(root, ...checkKey(key))
    const folder = dirname(file)
    if (create) await mkdir(folder, { recursive: true })
    const real = await realpath(folder).catch(() => folder)
    if (real !== root && !real.startsWith(root + sep))
      throw new StoreError(`"${key}" leads outside the destination folder`)
    return join(real, file.slice(folder.length + 1))
  }

  const store: Store = {
    key: (parts) => parts.join("/"),

    async put(key, file, _expected, signal) {
      const target = await place(key, true)
      const part = `${target}.part`
      await pipeline(createReadStream(file, { signal }), createWriteStream(part), { signal })
      const handle = await open(part, "r+")
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(part, target)
      return {}
    },

    verify: (key, expected, signal) => verifyByReading(store, key, expected, signal),

    async read(key) {
      const path = await place(key, false)
      return createReadStream(path)
    },

    async remove(key) {
      await rm(await place(key, false), { force: true })
    },

    async test(signal) {
      const root = await ready()
      await roundTrip(store, signal)
      const fs = await statfs(root)
      const freeGiB = (fs.bavail * fs.bsize) / 1024 ** 3
      return freeGiB < 5 ? [`Only ${freeGiB.toFixed(1)} GiB free in this folder.`] : []
    },

    async close() {},
  }
  return store
}

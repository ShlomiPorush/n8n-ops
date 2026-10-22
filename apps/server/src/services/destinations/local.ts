import { createReadStream, createWriteStream } from "node:fs"
import { lstat, mkdir, open, readFile, realpath, rename, rm, statfs } from "node:fs/promises"
import { join } from "node:path"
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
 * Archives under /backups/<folder>. Paths are plain names only, and no symbolic link under /backups is
 * followed, so archives stay inside that folder.
 */
export function localStore(location: LocalLocation, options: { root?: string; requireMount?: boolean } = {}): Store {
  const base = options.root ?? BACKUPS_DIR
  const requireMount = options.requireMount ?? true
  const folderParts = location.folder ? checkKey(location.folder) : []

  /**
   * Goes down from a folder one name at a time, creating what is missing when asked. A symbolic link on the
   * way is refused, so nothing is ever created or written outside /backups, whatever links are in it.
   */
  async function walk(from: string, parts: string[], create: boolean): Promise<string | null> {
    let current = from
    for (const part of parts) {
      current = join(current, part)
      const info = await lstat(current).catch(() => null)
      if (info?.isSymbolicLink())
        throw new StoreError(`${current} is a symbolic link; archives are not written through links`)
      if (!info) {
        if (!create) return null
        await mkdir(current).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error
        })
      } else if (!info.isDirectory()) throw new StoreError(`${current} is not a folder`)
    }
    return current
  }

  /** The destination's folder under /backups, created when missing. */
  async function ready() {
    if (requireMount && !(await isMountPoint(base))) throw notMapped()
    return (await walk(await realpath(base), folderParts, true)) as string
  }

  /** The archive's path under the destination; its folders are created when asked. */
  async function place(key: string, create: boolean) {
    const root = await ready()
    const parts = checkKey(key)
    const folder = await walk(root, parts.slice(0, -1), create)
    const file = join(folder ?? join(root, ...parts.slice(0, -1)), parts.at(-1) as string)
    if ((await lstat(file).catch(() => null))?.isSymbolicLink())
      throw new StoreError(`${file} is a symbolic link; archives are not written through links`)
    return file
  }

  const store: Store = {
    key: (parts) => parts.join("/"),

    async put(key, file, _expected, signal) {
      const target = await place(key, true)
      const part = `${target}.part`
      // A leftover temporary file goes first; the new one is created fresh ("wx"), never through a link.
      await rm(part, { force: true })
      await pipeline(createReadStream(file, { signal }), createWriteStream(part, { flags: "wx" }), { signal })
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

import { createHash } from "node:crypto"
import { posix } from "node:path"
import { Readable } from "node:stream"
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2"
import { checkKey, roundTrip, type Store, StoreError, verifyByReading } from "./store.ts"

export type SftpLocation = { host: string; port: number; username: string; path: string }
export type SftpCredentials = { password?: string; privateKey?: string; passphrase?: string; hostKey: string }

/** OpenSSH's form of a host key fingerprint: SHA256: and the unpadded base64 digest. */
export const fingerprint = (key: Buffer) =>
  `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`

const NO_SUCH_FILE = 2
/** Requests in flight and their size, for writing and reading archives. */
const PARALLEL = 32
const CHUNK = 32 * 1024

/**
 * The fingerprint of the key the server presents, read before any credential is sent: the connection ends at
 * the host key check, so the password or private key never leaves n8n-ops.
 */
export function fetchHostKey(host: string, port: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    let seen: string | null = null
    const done = (error?: Error) => {
      conn.end()
      if (seen) resolve(seen)
      else reject(error ?? new StoreError("the server presented no host key"))
    }
    signal.addEventListener("abort", () => done(new StoreError("the server did not answer in time")), { once: true })
    conn.on("error", (error) => done(seen ? undefined : error))
    conn.on("close", () => done())
    conn.connect({
      host,
      port,
      username: "n8n-ops-host-key-check",
      readyTimeout: 20_000,
      hostVerifier: (key: Buffer) => {
        seen = fingerprint(key)
        return false
      },
    })
  })
}

/** The folder as typed, without trailing slashes; "/" stays the root, and only an empty path is the home folder. */
export function sftpRoot(path: string) {
  const trimmed = path.trim()
  if (!trimmed) return "."
  return trimmed.replace(/(.)\/+$/, "$1")
}

export function sftpStore(location: SftpLocation, credentials: SftpCredentials): Store {
  let session: Promise<{ conn: Client; sftp: SFTPWrapper }> | null = null
  const root = sftpRoot(location.path)

  function connect(signal: AbortSignal) {
    if (!session) {
      session = new Promise((resolve, reject) => {
        const conn = new Client()
        let presented = ""
        const config: ConnectConfig = {
          host: location.host,
          port: location.port,
          username: location.username,
          readyTimeout: 20_000,
          // The pinned key is required; there is no way to connect without it.
          hostVerifier: (key: Buffer) => {
            presented = fingerprint(key)
            return presented === credentials.hostKey.trim()
          },
          ...(credentials.privateKey
            ? { privateKey: credentials.privateKey, passphrase: credentials.passphrase || undefined }
            : { password: credentials.password }),
        }
        conn.on("ready", () => conn.sftp((error, sftp) => (error ? reject(error) : resolve({ conn, sftp }))))
        conn.on("error", (error) => {
          session = null
          reject(
            presented && presented !== credentials.hostKey.trim()
              ? new StoreError(`the server's host key is ${presented}, not the pinned ${credentials.hostKey}`)
              : error,
          )
        })
        conn.on("close", () => {
          session = null
        })
        conn.connect(config)
      })
    }
    const current = session
    signal.addEventListener("abort", () => void current.then(({ conn }) => conn.end()).catch(() => {}), {
      once: true,
    })
    return current
  }

  const call = <T>(fn: (cb: (error: Error | null | undefined, value?: T) => void) => void) =>
    new Promise<T>((resolve, reject) => fn((error, value) => (error ? reject(error) : resolve(value as T))))
  const code = (error: unknown) => (error as { code?: number }).code

  /** The file's bytes in order, with several reads in flight, as fastGet does but without a local copy. */
  async function* readInOrder(sftp: SFTPWrapper, path: string, signal: AbortSignal) {
    const handle = await call<Buffer>((cb) => sftp.open(path, "r", cb))
    try {
      const { size } = await call<{ size: number }>((cb) => sftp.fstat(handle, cb))
      // Each read settles into a result, never a rejection left unwatched: a later read can fail, or the
      // connection drop, while an earlier one is still awaited.
      type Read = Promise<{ chunk: Buffer } | { error: Error }>
      const reads: Read[] = []
      let next = 0
      const ask = () => {
        if (next >= size) return
        const position = next
        const length = Math.min(CHUNK, size - position)
        next += length
        reads.push(
          new Promise((resolve) =>
            sftp.read(handle, Buffer.alloc(length), 0, length, position, (error, bytes, buffer) =>
              resolve(
                error
                  ? { error }
                  : bytes === length
                    ? { chunk: buffer }
                    : { error: new StoreError("the server sent a short read") },
              ),
            ),
          ),
        )
      }
      try {
        for (let i = 0; i < PARALLEL; i++) ask()
        while (reads.length) {
          signal.throwIfAborted()
          const read = await (reads.shift() as Read)
          if ("error" in read) throw read.error
          ask()
          yield read.chunk
        }
      } finally {
        // Reads still in flight finish before the handle closes, whether the copy was read whole or not.
        await Promise.all(reads)
      }
    } finally {
      await call((cb) => sftp.close(handle, cb)).catch(() => {})
    }
  }

  const pathOf = (key: string) => posix.join(root, ...checkKey(key))

  async function mkdirs(sftp: SFTPWrapper, folder: string) {
    const parts = posix.relative(root, folder).split("/").filter(Boolean)
    let current = root
    for (const part of parts) {
      current = posix.join(current, part)
      try {
        const stat = await call<{ isDirectory(): boolean }>((cb) => sftp.stat(current, cb))
        if (!stat.isDirectory()) throw new StoreError(`${current} exists and is not a folder`)
      } catch (error) {
        if (code(error) !== NO_SUCH_FILE) throw error
        await call((cb) => sftp.mkdir(current, cb))
      }
    }
  }

  async function replace(sftp: SFTPWrapper, from: string, to: string) {
    // posix-rename replaces an existing file in one step; plain SFTP rename refuses to.
    const ext = sftp as SFTPWrapper & { ext_openssh_rename?: SFTPWrapper["rename"] }
    try {
      if (ext.ext_openssh_rename) return await call((cb) => ext.ext_openssh_rename?.call(sftp, from, to, cb))
    } catch {
      // Fall through to a plain rename.
    }
    await call((cb) => sftp.unlink(to, cb)).catch(() => {})
    await call((cb) => sftp.rename(from, to, cb))
  }

  const store: Store = {
    key: (parts) => parts.join("/"),

    async put(key, file, _expected, signal) {
      const { sftp } = await connect(signal)
      const target = pathOf(key)
      await mkdirs(sftp, posix.dirname(target))
      const part = `${target}.part`
      // Many writes in flight: one at a time, SFTP waits for every reply and runs at a fraction of the line.
      // What arrives is read back and compared before the copy counts.
      await call((cb) => sftp.fastPut(file, part, { concurrency: PARALLEL, chunkSize: CHUNK }, cb))
      await replace(sftp, part, target)
      return {}
    },

    verify: (key, expected, signal) => verifyByReading(store, key, expected, signal),

    async read(key, signal) {
      const { sftp } = await connect(signal)
      return Readable.from(readInOrder(sftp, pathOf(key), signal))
    },

    async remove(key, signal) {
      const { sftp } = await connect(signal)
      try {
        await call((cb) => sftp.unlink(pathOf(key), cb))
      } catch (error) {
        if (code(error) !== NO_SUCH_FILE) throw error
      }
    },

    async test(signal) {
      const { sftp } = await connect(signal)
      try {
        await call((cb) => sftp.stat(root, cb))
      } catch (error) {
        if (code(error) === NO_SUCH_FILE) throw new StoreError(`the folder ${root} does not exist on the server`)
        throw error
      }
      await roundTrip(store, signal)
      return []
    },

    async close() {
      const current = session
      session = null
      if (current) await current.then(({ conn }) => conn.end()).catch(() => {})
    },
  }
  return store
}

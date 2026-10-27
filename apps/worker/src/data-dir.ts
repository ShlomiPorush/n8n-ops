import { randomUUID } from "node:crypto"
import { rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** What to do about a data folder the worker cannot write, by the error it got. */
function fix(code: string | undefined) {
  if (code === "EACCES" || code === "EPERM")
    return "on the host, give the folder mapped to it to UID 1000 (sudo chown 1000:1000 <folder>)"
  if (code === "EROFS") return "it is mounted read-only; mount it read-write"
  if (code === "ENOENT" || code === "ENOTDIR") return "it is not a folder; map a folder of the host to it"
  if (code === "ENOSPC" || code === "EDQUOT") return "the disk is full"
  return "check the folder mapped to it"
}

/**
 * Why the worker cannot keep its identity in the data folder, or null when it can. Checked before pairing: the
 * server spends the one-time token when it answers, so an identity that cannot be saved is lost with the token.
 * It saves a file the size of an identity the way saveIdentity does, so a full disk fails here too.
 */
export async function dataDirProblem(dir: string): Promise<string | null> {
  const probe = join(dir, `.write-test-${randomUUID()}`)
  try {
    await writeFile(probe, "x".repeat(512), { flag: "wx", mode: 0o600 })
    return null
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException
    return `cannot write ${dir} (${code ?? message}); ${fix(code)}`
  } finally {
    await rm(probe, { force: true }).catch(() => {})
  }
}

/**
 * Writes the identity to a new file beside it, then renames it into place. A rename replaces the old file
 * whatever its own permissions, so only the folder must be writable, as dataDirProblem checks.
 */
export async function saveIdentity(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

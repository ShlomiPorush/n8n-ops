import { randomBytes } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Ctx } from "../context.ts"
import {
  archiveParts,
  CONNECTION_HIDDEN,
  cleanFailure,
  connectionSecrets,
  dumpFailure,
  NoDestinationError,
  recordSelfFailure,
  runSelfBackup,
} from "./backups.ts"
import { checkKey } from "./destinations/store.ts"

/** A value made for the test, never a working credential. */
const made = (bytes = 12) => randomBytes(bytes).toString("hex")

describe("archiveParts", () => {
  const at = new Date("2026-10-22T02:00:05.123Z")
  const copy = "1a2b3c4d-0000-4000-8000-000000000000"

  it("puts an instance's archives in its own folder by year and month, with the copy in the name", () => {
    expect(archiveParts({ id: "i", name: "prod" }, copy, at)).toEqual([
      "prod",
      "2026",
      "10",
      "prod-20261022T020005Z-1a2b3c4d.tar.gz.age",
    ])
  })

  it("puts n8n-ops's own database dumps apart", () => {
    expect(archiveParts(null, copy, at)).toEqual([
      "_n8n-ops",
      "2026",
      "10",
      "n8n-ops-20261022T020005Z-1a2b3c4d.dump.age",
    ])
  })

  it("never makes a folder that climbs out of the destination, whatever the instance is called", () => {
    for (const name of [".", "..", "...", "a.b", "-x", "_n8n-ops"]) {
      const parts = archiveParts({ id: "0b8c-id", name }, copy, at)
      expect(() => checkKey(parts.join("/"))).not.toThrow()
    }
    expect(archiveParts({ id: "0b8c-id", name: ".." }, copy, at)[0]).toBe("0b8c-id")
  })
})

describe("connectionSecrets", () => {
  it("knows the password as written, as the URL standard writes it and decoded", () => {
    const [a, b] = [made(), made()]
    const { passwords, atInPassword } = connectionSecrets(`postgres://u:${a}%2F ${b}@db:5432/n8n_ops`)
    expect(passwords).toEqual(expect.arrayContaining([`${a}%2F ${b}`, `${a}%2F%20${b}`, `${a}/ ${b}`]))
    expect(atInPassword).toBe(false)
  })

  it("knows a password parameter with blanks and a broken escape, as written and without the blanks", () => {
    const [p, x, y] = [made(), made(), made()]
    const { passwords } = connectionSecrets(`postgres://u:${p}@db/n8n_ops?sslmode=require&password=${x}\t${y}%GG`)
    expect(passwords).toEqual(expect.arrayContaining([p, `${x}\t${y}%GG`, `${x}${y}%GG`]))
    expect(passwords.some((s) => s.includes("require"))).toBe(false)
  })

  it("knows password parameters after '#' and those with another name or blanks around the name", () => {
    const [p, q, s] = [made(), made(), made()]
    const { passwords } = connectionSecrets(`postgres://u:${p}@db/n8n_ops#?password=${q}& sslpassword =${s}`)
    expect(passwords).toEqual(expect.arrayContaining([p, q, s]))
  })

  it("tells when the password holds an '@' as written, and not when it is written as %40", () => {
    const [a, b] = [made(), made()]
    expect(connectionSecrets(`postgres://u:${a}@${b}@db/n8n_ops`).atInPassword).toBe(true)
    expect(connectionSecrets(`postgres://u:${a}%40${b}@db/n8n_ops`).atInPassword).toBe(false)
  })

  it("has nothing to hide when the URL holds no password", () => {
    expect(connectionSecrets("postgres://u@db/n8n_ops")).toEqual({
      url: "postgres://u@db/n8n_ops",
      passwords: [],
      atInPassword: false,
    })
  })
})

describe("cleanFailure", () => {
  const password = `${made(24)}%2F${made(12)}`
  const decoded = decodeURIComponent(password)
  const url = `postgres://n8n_ops:${password}@db:5432/n8n_ops`
  const connection = connectionSecrets(url)

  it("keeps an ordinary pg_dump report as it is", () => {
    const text = `pg_dump ended with exit code 1.\npg_dump: error: connection to server at "db" (10.1.2.3), port 5432 failed: FATAL:  password authentication failed for user "n8n_ops"`
    expect(cleanFailure(text, connection)).toBe(text)
  })

  it("names the URL instead of showing it", () => {
    expect(cleanFailure(`could not use ${url} now`, connection)).toBe("could not use [database URL] now")
  })

  it("hides the whole text when it shows the password decoded", () => {
    expect(cleanFailure(`for user "${decoded}"`, connection)).toBe(CONNECTION_HIDDEN)
  })

  it("hides the whole text when it shows the password as written", () => {
    expect(cleanFailure(`token "${password}"`, connection)).toBe(CONNECTION_HIDDEN)
  })

  it("hides the whole text when it shows the first 63 characters of the password", () => {
    expect(cleanFailure(`for user "${decoded.slice(0, 63)}"`, connection)).toBe(CONNECTION_HIDDEN)
  })

  it("hides the whole text when it shows a password as written with a blank", () => {
    const written = `${made()}%2F ${made()}`
    const blank = connectionSecrets(`postgres://u:${written}@db/n8n_ops`)
    expect(cleanFailure(`invalid percent-encoded token: "${written}"`, blank)).toBe(CONNECTION_HIDDEN)
  })

  it("hides the whole text when it shows a password parameter quoted as written", () => {
    const value = `${made()}\t${made()}%GG`
    const query = connectionSecrets(`postgres://u:${made()}@db/n8n_ops?password=${value}`)
    expect(cleanFailure(`invalid percent-encoded token: "${value}"`, query)).toBe(CONNECTION_HIDDEN)
  })

  it("hides every failure text when the password holds an '@' as written", () => {
    const at = connectionSecrets(`postgres://u:${made()}@${made()}@db/n8n_ops`)
    expect(cleanFailure("The archive has 3 MiB, more than the 2 MiB allowed.", at)).toBe(CONNECTION_HIDDEN)
  })

  it("keeps an ordinary text when the password holds an '@' written as %40", () => {
    const escaped = connectionSecrets(`postgres://u:${made()}%40${made()}@db/n8n_ops`)
    const text = "The archive has 3 MiB, more than the 2 MiB allowed."
    expect(cleanFailure(text, escaped)).toBe(text)
  })
})

describe("dumpFailure", () => {
  const url = `postgres://u:${made()}@db/n8n_ops`
  const failed = (fields: Record<string, unknown>) =>
    Object.assign(new Error(`Command failed: pg_dump --format=custom --no-owner ${url}`), {
      cmd: `pg_dump --format=custom --no-owner ${url}`,
      ...fields,
    })

  it("says how pg_dump ended and what it reported, not its command line", () => {
    const error = failed({ code: 1, signal: null, stderr: Buffer.from("pg_dump: error: no connection\n") })
    expect(dumpFailure(error)).toBe("pg_dump ended with exit code 1.\npg_dump: error: no connection")
  })

  it("says which signal stopped pg_dump", () => {
    expect(dumpFailure(failed({ code: null, signal: "SIGTERM", stderr: Buffer.alloc(0) }))).toBe(
      "pg_dump was stopped by SIGTERM.",
    )
  })

  it("names the error when pg_dump could not run", () => {
    expect(dumpFailure(failed({ code: "ENOENT", stderr: Buffer.alloc(0) }))).toBe("pg_dump failed (ENOENT).")
  })
})

describe("recording a failed backup of the n8n-ops database", () => {
  const password = made(24)
  const connection = connectionSecrets(`postgres://u:${password}@db/n8n_ops`)

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("logs only a cleaned text when the failure cannot be recorded, and does not throw", async () => {
    const errors: { message: string; extra?: Record<string, unknown> }[] = []
    const ctx = {
      log: {
        info: () => {},
        warn: () => {},
        error: (message: string, extra?: Record<string, unknown>) => errors.push({ message, extra }),
      },
    } as unknown as Ctx
    const record = async () => {
      throw new Error(`password authentication failed for user "${password}"`, { cause: new Error(password) })
    }
    await expect(recordSelfFailure(ctx, "run", "pg_dump ended with exit code 1.", connection, record)).resolves.toBe(
      undefined,
    )
    expect(errors).toEqual([{ message: "could not record the failed backup", extra: { error: CONNECTION_HIDDEN } }])
  })

  it("cleans an error raised before the run is recorded", async () => {
    const own = made(24)
    vi.stubEnv("DATABASE_URL", `postgres://u:${own}@db/n8n_ops`)
    const ctx = {
      settings: {
        get: async () => {
          throw new Error(`password authentication failed for user "${own}"`)
        },
      },
    } as unknown as Ctx
    const error = await runSelfBackup(ctx).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(CONNECTION_HIDDEN)
    expect((error as Error).cause).toBeUndefined()
  })

  it("passes on that no destination is chosen as it is", async () => {
    vi.stubEnv("DATABASE_URL", `postgres://u:${made()}@db/n8n_ops`)
    const ctx = {
      settings: { get: async () => ({ selfDestinations: "custom", selfDestinationIds: [] }) },
    } as unknown as Ctx
    await expect(runSelfBackup(ctx)).rejects.toBeInstanceOf(NoDestinationError)
  })
})

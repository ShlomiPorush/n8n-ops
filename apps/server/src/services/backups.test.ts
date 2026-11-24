import { randomBytes } from "node:crypto"
import postgres from "postgres"
import { describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { archiveParts, dumpConnection, dumpFailure, NoDestinationError, runSelfBackup } from "./backups.ts"
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

describe("dumpConnection", () => {
  it("takes the password out of the URL and leaves the rest as it is", () => {
    const password = made(24)
    expect(
      dumpConnection(`postgres://n8n_ops:${password}@db:5432/n8n_ops?sslmode=require&application_name=a:b@c`),
    ).toEqual({ url: "postgres://n8n_ops@db:5432/n8n_ops?sslmode=require&application_name=a:b@c", password })
  })

  it.each(["@", "#", ":", "%40", "%2F", "%3A", " ", "@h#", "@h:1#x@y"])(
    "gives the password postgres.js connects with, and no part of it in the URL, when %j is in it",
    async (mark) => {
      const [a, b] = [made(), made()]
      const given = `postgres://n8n_ops:${a}${mark}${b}@db:5432/n8n_ops`
      const { url, password } = dumpConnection(given)
      const library = postgres(given)
      expect(password).toBe(library.options.pass)
      await library.end()
      expect(password).toBe(decodeURIComponent(`${a}${mark}${b}`))
      expect(url).toBe("postgres://n8n_ops@db:5432/n8n_ops")
    },
  )

  it("leaves out the fragment, which the server ignores", () => {
    const [password, other] = [made(), made()]
    expect(dumpConnection(`postgres://u:${password}@db:5432/n8n_ops#?password=${other}`)).toEqual({
      url: "postgres://u@db:5432/n8n_ops",
      password,
    })
  })

  it("finds none in a URL without one", () => {
    const url = "postgres://u@db:5432/n8n_ops?application_name=http://a:b@c"
    expect(dumpConnection(url)).toEqual({ url, password: "" })
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

describe("a backup of the n8n-ops database", () => {
  it("passes on that no destination is chosen as it is", async () => {
    const ctx = {
      settings: { get: async () => ({ selfDestinations: "custom", selfDestinationIds: [] }) },
    } as unknown as Ctx
    await expect(runSelfBackup(ctx)).rejects.toBeInstanceOf(NoDestinationError)
  })
})

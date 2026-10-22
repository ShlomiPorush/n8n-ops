import { describe, expect, it } from "vitest"
import { describeDatabaseError } from "./errors.ts"

const url = "postgres://n8n_ops:secret-pass@postgres:5432/n8n_ops"

// The shape postgres.js and Drizzle produce: the code sits on the cause of the query error.
function queryError(code: string) {
  return Object.assign(new Error('Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"'), {
    cause: Object.assign(new Error("server error"), { code }),
  })
}

describe("describeDatabaseError", () => {
  it("explains a refused password and how to set it again", () => {
    const text = describeDatabaseError(queryError("28P01"), url)
    expect(text).toContain('refused the password for user "n8n_ops"')
    expect(text).toContain("docker compose exec postgres psql -U n8n_ops -d n8n_ops")
    expect(text).toContain("\\password n8n_ops")
  })

  it("never repeats the password", () => {
    expect(describeDatabaseError(queryError("28P01"), url)).not.toContain("secret-pass")
    expect(describeDatabaseError(queryError("ECONNREFUSED"), url)).not.toContain("secret-pass")
  })

  it("names the host that cannot be reached", () => {
    expect(describeDatabaseError(queryError("ECONNREFUSED"), url)).toContain("Cannot reach PostgreSQL at postgres:5432")
    expect(describeDatabaseError(Object.assign(new Error("x"), { code: "ENOTFOUND" }), url)).toContain("(ENOTFOUND)")
  })

  it("explains a connection that opened but never answered as PostgreSQL", () => {
    // postgres.js reports this one with its own code, not ETIMEDOUT.
    expect(describeDatabaseError(queryError("CONNECT_TIMEOUT"), url)).toContain(
      "Cannot reach PostgreSQL at postgres:5432 (CONNECT_TIMEOUT)",
    )
  })

  it("names a refused user or a missing database", () => {
    expect(describeDatabaseError(queryError("28000"), url)).toContain(
      'refused user "n8n_ops" before checking a password',
    )
    expect(describeDatabaseError(queryError("3D000"), url)).toContain('no database "n8n_ops"')
  })

  it("leaves other errors alone", () => {
    expect(describeDatabaseError(queryError("42P01"), url)).toBeNull()
    expect(describeDatabaseError(new Error("no code"), url)).toBeNull()
    expect(describeDatabaseError("text", url)).toBeNull()
  })
})

import { describe, expect, it } from "vitest"
import { runFailure } from "./backups.tsx"

const copy = (error: string | null) => ({
  id: "c",
  destinationId: "d",
  destination: "NAS",
  kind: "local" as const,
  status: "failed" as const,
  error,
  attempts: 1,
  retainUntil: null,
  legacy: false,
  deletedAt: null,
})

describe("runFailure", () => {
  const spooledAt = "2026-10-22T02:00:05.123Z"

  it("shows why a run failed before its archive was ready, which its copies do not say", () => {
    expect(
      runFailure({
        status: "failed",
        spooledAt: null,
        error: "Upload failed: Not enough free space in the data directory for a 900 MiB archive",
        copies: [copy("The backup failed before this copy could be written.")],
      }),
    ).toMatch(/free space/)
  })

  it("does not repeat what the copies already say", () => {
    expect(
      runFailure({
        status: "failed",
        spooledAt,
        error: "NAS: connection refused",
        copies: [copy("connection refused")],
      }),
    ).toBeNull()
  })

  it("shows the error of a run without copies, and nothing for a run that did not fail", () => {
    expect(runFailure({ status: "failed", spooledAt: null, error: "No backup key.", copies: [] })).toBe(
      "No backup key.",
    )
    const error = "NAS: connection refused"
    expect(runFailure({ status: "failed", spooledAt, error, copies: [] })).toBe(error)
    expect(runFailure({ status: "ok", spooledAt, error: null, copies: [] })).toBeNull()
  })
})

import { describe, expect, it } from "vitest"
import { healthSchema } from "./health.ts"

describe("healthSchema", () => {
  it("accepts a healthy response", () => {
    const parsed = healthSchema.parse({ status: "ok", version: "0.1.0", checks: { database: "ok" } })
    expect(parsed.checks.database).toBe("ok")
  })

  it("rejects an unknown status", () => {
    expect(healthSchema.safeParse({ status: "degraded", version: "0.1.0", checks: {} }).success).toBe(false)
  })
})

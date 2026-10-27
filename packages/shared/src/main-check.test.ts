import { describe, expect, it } from "vitest"
import { workerCheckOutput } from "./main-check.ts"

// What the check in a queue worker may send about it: each figure bounded, and one that does not fit dropped alone.
describe("workerCheckOutput details", () => {
  const parse = (details: Record<string, unknown>) => workerCheckOutput.parse({ active: true, details }).details

  it("takes a version of at most 40 characters with numbers of at most six digits, and a suffix after a separator", () => {
    expect(parse({ version: "2.44.3" })?.version).toBe("2.44.3")
    expect(parse({ version: "2.44.3-beta.1" })?.version).toBe("2.44.3-beta.1")
    expect(parse({ version: "2.44.1234567" })?.version).toBeUndefined()
    expect(parse({ version: `2.44.3-${"a".repeat(40)}` })?.version).toBeUndefined()
  })

  it("drops a figure that does not fit, and keeps the others", () => {
    const details = parse({ version: "2.44.3", uptimeSec: -1, memory: { used: 10, limit: null }, concurrencyEnv: "7" })
    expect(details).toEqual({ version: "2.44.3", memory: { used: 10, limit: null } })
  })
})

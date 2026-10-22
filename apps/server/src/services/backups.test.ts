import { describe, expect, it } from "vitest"
import { archiveParts } from "./backups.ts"
import { checkKey } from "./destinations/store.ts"

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

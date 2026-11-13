import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { readVersion } from "./version.ts"

const dir = mkdtempSync(join(tmpdir(), "n8n-ops-worker-version-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

it("is the first line of the VERSION file, or dev without one", () => {
  writeFileSync(join(dir, "VERSION"), "0.18.0\n")
  expect(readVersion(join(dir, "VERSION"))).toBe("0.18.0")
  expect(readVersion(join(dir, "missing"))).toBe("dev")
  expect(() => readVersion(dir)).toThrow()
})

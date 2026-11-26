import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { advisoryLocks } from "./advisory-locks.ts"

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : []
  })
}

describe("PostgreSQL advisory locks", () => {
  it("each have their own key, and no code takes one by a number of its own", () => {
    const keys = Object.values(advisoryLocks)
    expect(new Set(keys).size).toBe(keys.length)
    const own = sources(join(import.meta.dirname, ".."))
      .filter((file) => !file.endsWith("advisory-locks.ts"))
      .filter((file) =>
        /pg_(try_)?advisory_(xact_)?lock(_shared)?\(\$\{\s*\d|const \w+ = (7_243_\d{3}|0x6e386f6)/.test(
          readFileSync(file, "utf8"),
        ),
      )
    expect(own).toEqual([])
  })
})

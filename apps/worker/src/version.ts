import { readFileSync } from "node:fs"

export function readVersion(file: string | URL = new URL("../VERSION", import.meta.url)): string {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "dev"
    throw error
  }
  return text.split(/\r?\n/, 1)[0]?.trim() || "dev"
}

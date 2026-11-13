import { readFileSync } from "node:fs"

/**
 * The version of this build: the first line of the VERSION file the image keeps beside dist/ (/app/VERSION), copied
 * from the repository root, which the release updates. Never read from the environment, so a container cannot report
 * another version. "dev" when there is no such file or it is blank, as when the server runs from source; any other
 * error reading it stops the start.
 */
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

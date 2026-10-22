import { defineConfig } from "vitest/config"

// Unit tests. Tests named *.integration.test.ts need the verification stack and run from scripts/verify.sh.
export default defineConfig({
  test: { exclude: ["**/node_modules/**", "**/*.integration.test.ts"] },
})

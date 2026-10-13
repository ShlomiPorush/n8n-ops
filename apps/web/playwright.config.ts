import { defineConfig } from "@playwright/test"

// End-to-end tests run against an already running stack; scripts/verify.sh starts it.
export default defineConfig({
  testDir: "e2e",
  reporter: "list",
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8080" },
})

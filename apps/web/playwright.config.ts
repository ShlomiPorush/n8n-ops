import { defineConfig } from "@playwright/test"

// End-to-end tests run against an already running stack; scripts/verify.sh starts it.
// Spec files share one fresh database and run in file order in a single worker.
export default defineConfig({
  testDir: "e2e",
  reporter: "list",
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8080" },
})

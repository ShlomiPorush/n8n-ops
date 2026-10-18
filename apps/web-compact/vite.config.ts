/// <reference types="vitest/config" />
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  // The server serves this design's files under /compact/assets; page addresses stay at the root.
  base: "/compact/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  // Unit tests only; Playwright specs in e2e/ run separately against a running stack.
  test: { include: ["src/**/*.test.{ts,tsx}"] },
  server: {
    // Development: the UI dev server forwards API and health calls to a running server.
    proxy: { "/api": "http://localhost:8080", "/healthz": "http://localhost:8080" },
  },
})

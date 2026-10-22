import { defineConfig } from "vitest/config"

// Integration tests against the verification stack: a real PostgreSQL, S3Mock, an SFTP and a WebDAV server.
// scripts/verify.sh starts them and passes their addresses in the environment.
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})

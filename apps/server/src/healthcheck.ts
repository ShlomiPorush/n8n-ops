import { existsSync } from "node:fs"
import { DRAIN_FILE } from "./drain-file.ts"

const port = process.env.PORT ?? "8080"

if (existsSync(DRAIN_FILE)) process.exit(1)

try {
  const res = await fetch(`http://127.0.0.1:${port}/healthz/ready`, { signal: AbortSignal.timeout(4000) })
  process.exit(res.ok ? 0 : 1)
} catch {
  process.exit(1)
}

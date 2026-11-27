import { writeFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { DRAIN_FILE, DRAIN_WAIT_MS } from "./drain-file.ts"

writeFileSync(DRAIN_FILE, "")
await sleep(DRAIN_WAIT_MS)

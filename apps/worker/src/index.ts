import { DEFAULT_HEARTBEAT_FILE, recordContact } from "./heartbeat.ts"

// Foundation placeholder: the worker only proves it can reach the server.
// Pairing, jobs and Docker access arrive with the backup features.
const serverUrl = process.env.N8N_OPS_SERVER_URL
if (!serverUrl) {
  console.error("N8N_OPS_SERVER_URL is required")
  process.exit(1)
}
const heartbeatFile = process.env.HEARTBEAT_FILE ?? DEFAULT_HEARTBEAT_FILE
const intervalMs = 15_000

async function beat() {
  try {
    const res = await fetch(new URL("/healthz/live", serverUrl), { signal: AbortSignal.timeout(5000) })
    if (res.ok) await recordContact(heartbeatFile)
    else console.warn(`Server answered ${res.status}`)
  } catch (error) {
    console.warn(`Server not reachable: ${(error as Error).message}`)
  }
}

console.log(`n8n-ops worker ${process.env.N8N_OPS_VERSION ?? "dev"} reporting to ${serverUrl}`)
await beat()
const timer = setInterval(beat, intervalMs)

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    clearInterval(timer)
    process.exit(0)
  })
}

// Container health check: healthy only after a recent successful contact with the server.
import { DEFAULT_HEARTBEAT_FILE, isFresh, readLastContact } from "./heartbeat.ts"

const last = await readLastContact(process.env.HEARTBEAT_FILE ?? DEFAULT_HEARTBEAT_FILE)
process.exit(isFresh(last, Date.now()) ? 0 : 1)

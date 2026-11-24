// Container health check: healthy while the Worker process keeps marking itself alive, whether or not it reaches the
// server (that is the Worker's online status in n8n-ops).
import { ALIVE_FILE, isFresh, readLastAlive } from "./alive.ts"

process.exit(isFresh(await readLastAlive(ALIVE_FILE), Date.now()) ? 0 : 1)

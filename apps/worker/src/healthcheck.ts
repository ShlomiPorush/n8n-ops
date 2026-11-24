import { ALIVE_FILE, isFresh, readLastAlive } from "./alive.ts"

process.exit(isFresh(await readLastAlive(ALIVE_FILE), Date.now()) ? 0 : 1)

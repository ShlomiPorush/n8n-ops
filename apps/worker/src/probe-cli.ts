import { Docker } from "./docker.ts"
import { probeJob } from "./jobs.ts"

const payload = JSON.parse(process.argv[2] ?? "{}") as Record<string, unknown>
const docker = new Docker(process.env.DOCKER_HOST || process.env.DOCKER_SOCKET || "/var/run/docker.sock")
const outcome = await probeJob(payload, docker)
process.stdout.write(`${JSON.stringify(outcome.result ?? { error: outcome.error })}\n`)

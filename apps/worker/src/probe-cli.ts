import { Docker } from "./docker.ts"
import { probeJob } from "./jobs.ts"

/**
 * Runs one health probe on this host, as the server would ask for it, and prints the report: a way to see what the
 * worker sees, without the server. For example, in the worker's folder:
 *   docker compose exec worker node dist/probe-cli.js '{"inside":{"container":"n8n"},"discover":true}'
 * The verification stack uses it to check the queue workers through the real socket proxy.
 */
const payload = JSON.parse(process.argv[2] ?? "{}") as Record<string, unknown>
const docker = new Docker(process.env.DOCKER_HOST || process.env.DOCKER_SOCKET || "/var/run/docker.sock")
const outcome = await probeJob(payload, docker)
process.stdout.write(`${JSON.stringify(outcome.result ?? { error: outcome.error })}\n`)

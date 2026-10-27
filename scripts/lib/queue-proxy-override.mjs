// For scripts/verify.sh: the Compose override that gives the queue checks' socket proxy the lines n8n-ops computes
// from one probe's report (PROBE_REPORT), with the main given (PROBE_MAIN). The same function the server uses.
import { neededRule } from "../../packages/shared/src/proxy-rules.ts"

const report = JSON.parse(process.env.PROBE_REPORT ?? "{}")
const main = process.env.PROBE_MAIN ?? ""
const rule = neededRule({
  entered: [],
  mains: [{ instance: "queue", container: main }],
  queueWorkers: (report.listed?.names ?? []).map((name) => ({ instance: "queue", name })),
})
if (rule.coverage !== "complete") {
  console.error(`the lines are not complete: ${rule.gaps.join("; ")}`)
  process.exit(1)
}
process.stdout.write(`services:
  queue-proxy:
    command:
      - -listenip=0.0.0.0
      - -allowfrom=queue-probe
      - -allowhealthcheck
${rule.lines}
`)

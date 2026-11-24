export const METRICS_MAX_BYTES = 4 * 1024 * 1024

export type QueueMetrics = { waiting: number; active: number; completed: number; failed: number }

export async function readMetricsText(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ""
  const decoder = new TextDecoder()
  let size = 0
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    size += value.byteLength
    if (size > METRICS_MAX_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error(`the metrics answer is larger than ${METRICS_MAX_BYTES / 1024 / 1024} MiB`)
    }
    text += decoder.decode(value, { stream: true })
  }
}

export const METRIC_LABELS = String.raw`\{[^}\r\n  ]*\}`
export const METRIC_GAP = String.raw`[ \t]+`

export function parseVersionMetric(text: string): string | null {
  const match = text.match(/^[a-zA-Z0-9_]*version_info\{[^}\r\n\u2028\u2029]*\bversion="v?([^"\r\n\u2028\u2029]+)"/m)
  return match?.[1] ?? null
}

export function parseQueueMetrics(text: string): QueueMetrics | null {
  const read = (name: string) => {
    const pattern = `^[a-zA-Z0-9_]*scaling_mode_queue_jobs_${name}(?:_total)?(?:${METRIC_LABELS})?${METRIC_GAP}([0-9.eE+-]+)$`
    const match = text.match(new RegExp(pattern, "m"))
    return match ? Number(match[1]) : null
  }
  const waiting = read("waiting")
  if (waiting === null) return null
  return { waiting, active: read("active") ?? 0, completed: read("completed") ?? 0, failed: read("failed") ?? 0 }
}

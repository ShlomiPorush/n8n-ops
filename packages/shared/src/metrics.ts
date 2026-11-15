/** The largest metrics answer read over the network, as the check inside the main container reads it. */
export const METRICS_MAX_BYTES = 4 * 1024 * 1024

export type QueueMetrics = { waiting: number; active: number; completed: number; failed: number }

/**
 * Reads a metrics answer's body as text, up to METRICS_MAX_BYTES. A larger answer is refused with an error that
 * says so, and the rest of it is not read. The caller's deadline (the fetch's signal) also ends the read.
 */
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

/*
 * Every sample is matched within its own line: no part of a pattern below crosses a line end, and a line end is
 * any character that ends a line for `^` and `$` in a multiline pattern. So a parse takes time in proportion to
 * the text, whatever the text holds.
 */

/**
 * Pattern sources for the parts of a sample line, each within one line: a label set, and the space between the name
 * (or its labels) and the value. The check inside the main container builds its patterns from them too.
 */
export const METRIC_LABELS = String.raw`\{[^}\r\n  ]*\}`
export const METRIC_GAP = String.raw`[ \t]+`

/** The version from n8n's version_info metric (any prefix), without the leading "v". */
export function parseVersionMetric(text: string): string | null {
  const match = text.match(/^[a-zA-Z0-9_]*version_info\{[^}\r\n\u2028\u2029]*\bversion="v?([^"\r\n\u2028\u2029]+)"/m)
  return match?.[1] ?? null
}

/** Reads queue gauges from n8n's Prometheus /metrics output. */
export function parseQueueMetrics(text: string): QueueMetrics | null {
  const read = (name: string) => {
    // The prefix is configurable in n8n (N8N_METRICS_PREFIX, default "n8n_"); counters may end in _total.
    const pattern = `^[a-zA-Z0-9_]*scaling_mode_queue_jobs_${name}(?:_total)?(?:${METRIC_LABELS})?${METRIC_GAP}([0-9.eE+-]+)$`
    const match = text.match(new RegExp(pattern, "m"))
    return match ? Number(match[1]) : null
  }
  const waiting = read("waiting")
  if (waiting === null) return null
  return { waiting, active: read("active") ?? 0, completed: read("completed") ?? 0, failed: read("failed") ?? 0 }
}

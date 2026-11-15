import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { METRICS_MAX_BYTES, parseQueueMetrics, parseVersionMetric, readMetricsText } from "./metrics.ts"

/** Runs `parse` once and returns its result with the time it took. */
function timed<T>(parse: () => T) {
  const started = performance.now()
  const result = parse()
  return { result, ms: performance.now() - started }
}

/** Far above what a linear parse of these inputs takes, far below what one that rescans the text would. */
const QUICK_MS = 250
const LINES = 20_000

describe("parseVersionMetric", () => {
  it("reads the version without the leading v", () => {
    const text = [
      "# TYPE n8n_version_info gauge",
      'n8n_version_info{version="v2.44.0",major="2",minor="44",patch="0"} 1',
    ].join("\n")
    expect(parseVersionMetric(text)).toBe("2.44.0")
  })

  it("returns null without the metric", () => {
    expect(parseVersionMetric("process_cpu_seconds_total 1")).toBeNull()
  })

  it.each([
    ["an unclosed label set", "n8n_version_info{a\n"],
    ["an unclosed version value", 'n8n_version_info{version="x\n'],
    ["an unclosed label set ending in a carriage return", "n8n_version_info{a\r"],
    ["an unclosed version value ending in a line separator", 'n8n_version_info{version="x\u2028'],
    ["an unclosed label set ending in a paragraph separator", "n8n_version_info{a\u2029"],
  ])("reads each line on its own and stays quick on lines with %s", (_, line) => {
    const { result, ms } = timed(() => parseVersionMetric(line.repeat(LINES)))
    expect(result).toBeNull()
    expect(ms).toBeLessThan(QUICK_MS)
  })

  it("finds the version after many malformed lines", () => {
    const text = `${"n8n_version_info{a\n".repeat(LINES)}n8n_version_info{version="v2.44.0"} 1\n`
    const { result, ms } = timed(() => parseVersionMetric(text))
    expect(result).toBe("2.44.0")
    expect(ms).toBeLessThan(QUICK_MS)
  })
})

describe("parseQueueMetrics", () => {
  it("reads the queue gauges", () => {
    const text = [
      "# HELP n8n_scaling_mode_queue_jobs_waiting Current number of enqueued jobs",
      "n8n_scaling_mode_queue_jobs_waiting 312",
      "n8n_scaling_mode_queue_jobs_active 4",
      "n8n_scaling_mode_queue_jobs_completed_total 18204",
      "n8n_scaling_mode_queue_jobs_failed 37",
    ].join("\n")
    expect(parseQueueMetrics(text)).toEqual({ waiting: 312, active: 4, completed: 18204, failed: 37 })
  })

  it("reads gauges with labels, tabs and Windows line ends", () => {
    const text = [
      'n8n_scaling_mode_queue_jobs_waiting{queue="jobs"}\t3',
      'n8n_scaling_mode_queue_jobs_active{queue="jobs"} 2',
      "n8n_scaling_mode_queue_jobs_completed_total 10",
      "n8n_scaling_mode_queue_jobs_failed_total 1",
    ].join("\r\n")
    expect(parseQueueMetrics(text)).toEqual({ waiting: 3, active: 2, completed: 10, failed: 1 })
  })

  it("accepts a custom prefix", () => {
    expect(parseQueueMetrics("acme_scaling_mode_queue_jobs_waiting 5")?.waiting).toBe(5)
  })

  it("returns null without queue metrics", () => {
    expect(parseQueueMetrics("process_cpu_seconds_total 1")).toBeNull()
  })

  it("does not take a value from the next line", () => {
    expect(parseQueueMetrics("n8n_scaling_mode_queue_jobs_waiting\n5")).toBeNull()
  })

  it.each([
    ["an unclosed label set", "n8n_scaling_mode_queue_jobs_waiting{a\n"],
    ["an unclosed label set ending in a carriage return", "n8n_scaling_mode_queue_jobs_waiting{a\r"],
    ["an unclosed label set ending in a line separator", "n8n_scaling_mode_queue_jobs_waiting{a\u2028"],
    ["an unclosed label set ending in a paragraph separator", "n8n_scaling_mode_queue_jobs_waiting{a\u2029"],
  ])("reads each line on its own and stays quick on lines with %s", (_, line) => {
    const { result, ms } = timed(() => parseQueueMetrics(line.repeat(LINES)))
    expect(result).toBeNull()
    expect(ms).toBeLessThan(QUICK_MS)
  })

  it("finds the gauges after many malformed lines", () => {
    const text = `${"n8n_scaling_mode_queue_jobs_waiting{a\n".repeat(LINES)}n8n_scaling_mode_queue_jobs_waiting 3\n`
    const { result, ms } = timed(() => parseQueueMetrics(text))
    expect(result).toEqual({ waiting: 3, active: 0, completed: 0, failed: 0 })
    expect(ms).toBeLessThan(QUICK_MS)
  })
})

/** A response whose body comes in the given chunks, counting how many were read. */
function chunked(chunks: Uint8Array[], endless?: Uint8Array) {
  const state = { pulled: 0, cancelled: false }
  let next = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled++
      const chunk = chunks[next++] ?? endless
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
    cancel() {
      state.cancelled = true
    },
  })
  return { res: new Response(body), state }
}

describe("readMetricsText", () => {
  it("reads an answer of exactly the largest size", async () => {
    const text = await readMetricsText(new Response(new Uint8Array(METRICS_MAX_BYTES).fill(0x61)))
    expect(text.length).toBe(METRICS_MAX_BYTES)
  })

  it("refuses an answer one byte larger, saying why", async () => {
    await expect(readMetricsText(new Response(new Uint8Array(METRICS_MAX_BYTES + 1).fill(0x61)))).rejects.toThrow(
      "the metrics answer is larger than 4 MiB",
    )
  })

  it("stops reading an answer that does not end once it passed the largest size", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x61)
    const { res, state } = chunked([], chunk)
    await expect(readMetricsText(res)).rejects.toThrow("larger than 4 MiB")
    expect(state.cancelled).toBe(true)
    expect(state.pulled).toBeLessThanOrEqual(METRICS_MAX_BYTES / chunk.byteLength + 2)
  })

  it("keeps characters whose bytes are split between chunks", async () => {
    const bytes = new TextEncoder().encode('n8n_version_info{version="é"} 1')
    const at = bytes.indexOf(0xc3) + 1
    const { res } = chunked([bytes.slice(0, at), bytes.slice(at)])
    expect(await readMetricsText(res)).toBe('n8n_version_info{version="é"} 1')
  })

  it("ends an answer cut inside a character with a replacement character", async () => {
    const bytes = new TextEncoder().encode("n8n_é")
    const { res } = chunked([bytes.slice(0, bytes.length - 1)])
    expect(await readMetricsText(res)).toBe(`n8n_${String.fromCharCode(0xfffd)}`)
  })

  it("passes on a read that fails after earlier chunks came", async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode("n8n_"))
        else controller.error(new Error("connection reset"))
      },
    })
    await expect(readMetricsText(new Response(body))).rejects.toThrow("connection reset")
  })

  it("refuses a larger answer with the size error even when letting the rest go fails", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x61)
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk)
      },
      cancel() {
        throw new Error("cancel failed")
      },
    })
    await expect(readMetricsText(new Response(body))).rejects.toThrow("larger than 4 MiB")
  })

  it("stops at the caller's deadline when the answer stalls below the largest size", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200)
      res.write("n8n_")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/metrics`
      const res = await fetch(url, { signal: AbortSignal.timeout(300) })
      await expect(readMetricsText(res)).rejects.toMatchObject({ name: "TimeoutError" })
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it("reads an answer without a body as empty", async () => {
    expect(await readMetricsText(new Response(null))).toBe("")
  })
})

/** The largest health answer read; anything past it is not needed to time the request. */
const MAX_BODY = 64 * 1024

/**
 * One health request over the network, as the server and the worker make it. `ms` is the time until the call ended,
 * whatever happened, as before. `requestMs` is the same request until its whole answer (up to 64 KiB) arrived, so it
 * means the same as the time the check inside a container measures; it is absent when no whole answer came. `code`
 * names what failed when it is known: the system error code, or `timeout` for the deadline.
 */
export type RequestReading = {
  ok: boolean
  status: number
  ms: number
  requestMs?: number
  error?: string
  code?: string
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export async function requestOnce(url: string, signal: AbortSignal, fetchImpl: Fetch = fetch): Promise<RequestReading> {
  const started = Date.now()
  try {
    const res = await fetchImpl(url, { signal })
    await readUpTo(res, MAX_BODY)
    const ms = Date.now() - started
    return { ok: res.ok, status: res.status, ms, requestMs: ms }
  } catch (error) {
    const code = errorCode(error)
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: (error as Error).message,
      ...(code ? { code } : {}),
    }
  }
}

/** Reads an answer's body until it ends or `max` bytes came, then lets the rest go. */
async function readUpTo(res: Response, max: number) {
  const reader = res.body?.getReader()
  if (!reader) return
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    size += value.byteLength
    if (size >= max) {
      await reader.cancel().catch(() => {})
      return
    }
  }
}

/** The error code of a failed fetch: Node puts the system code on `cause`; a deadline is a TimeoutError. */
export function errorCode(error: unknown): string | undefined {
  const e = error as { name?: string; code?: unknown; cause?: { code?: unknown } }
  if (e?.name === "TimeoutError") return "timeout"
  const code = e?.cause?.code ?? e?.code
  return typeof code === "string" && code.length <= 40 ? code : undefined
}

const MAX_BODY = 64 * 1024

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
    const ms = Date.now() - started
    const whole = await readUpTo(res, MAX_BODY).then(
      () => true,
      () => false,
    )
    return { ok: res.ok, status: res.status, ms, ...(whole ? { requestMs: Date.now() - started } : {}) }
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

export function errorCode(error: unknown): string | undefined {
  const e = error as { name?: string; code?: unknown; cause?: { code?: unknown } }
  if (e?.name === "TimeoutError") return "timeout"
  const code = e?.cause?.code ?? e?.code
  return typeof code === "string" && code.length <= 40 ? code : undefined
}

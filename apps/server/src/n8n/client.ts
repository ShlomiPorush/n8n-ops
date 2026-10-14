/** Minimal client for the n8n public API (v1) and the unauthenticated health endpoints. */

export type N8nExecution = {
  id: string
  status: string
  mode?: string
  startedAt?: string | null
  stoppedAt?: string | null
  workflowId: string
  data?: unknown
  workflowData?: N8nWorkflow
  dataTooLargeToDisplay?: boolean
}

export type N8nNode = {
  id?: string
  name: string
  type: string
  parameters?: Record<string, unknown>
  credentials?: Record<string, { id?: string; name?: string }>
  disabled?: boolean
}

export type N8nWorkflow = {
  id: string
  name: string
  active: boolean
  isArchived?: boolean
  nodes: N8nNode[]
  connections: Record<string, { main?: ({ node: string; type: string; index: number }[] | null)[] }>
  settings?: Record<string, unknown>
  staticData?: unknown
  updatedAt?: string
}

export type N8nCredential = { id: string; name: string; type: string }

export class N8nError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message)
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export class N8nClient {
  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  private url(path: string, query: Record<string, string | number | boolean | undefined> = {}) {
    const url = new URL(`${this.baseUrl.replace(/\/+$/, "")}${path}`)
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v))
    return url.toString()
  }

  private async api<T>(
    method: string,
    path: string,
    { query, body }: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const res = await this.fetchImpl(this.url(`/api/v1${path}`, query), {
      method,
      headers: {
        "X-N8N-API-KEY": this.apiKey,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const text = await res.text()
    if (!res.ok) throw new N8nError(`n8n answered ${res.status} for ${method} ${path}`, res.status, text.slice(0, 500))
    return (text ? JSON.parse(text) : null) as T
  }

  /** Scopes of the API key, or null when the instance has no /discover endpoint (n8n older than 2.14.0). */
  async discoverScopes(): Promise<string[] | null> {
    try {
      const res = await this.api<{ data?: { scopes?: string[] } }>("GET", "/discover")
      return res.data?.scopes ?? []
    } catch (error) {
      if (error instanceof N8nError && error.status === 404) return null
      throw error
    }
  }

  /** Error executions, newest first, with their data. */
  listErrorExecutions(cursor?: string, limit = 50) {
    return this.api<{ data: N8nExecution[]; nextCursor: string | null }>("GET", "/executions", {
      query: { status: "error", includeData: true, limit, cursor },
    })
  }

  listExecutions(query: {
    status?: string
    workflowId?: string
    limit?: number
    cursor?: string
    startedAfter?: string
  }) {
    return this.api<{ data: N8nExecution[]; nextCursor: string | null }>("GET", "/executions", { query })
  }

  getExecution(id: string) {
    return this.api<N8nExecution>("GET", `/executions/${encodeURIComponent(id)}`, { query: { includeData: true } })
  }

  async listWorkflows(): Promise<N8nWorkflow[]> {
    const all: N8nWorkflow[] = []
    let cursor: string | undefined
    do {
      const page = await this.api<{ data: N8nWorkflow[]; nextCursor: string | null }>("GET", "/workflows", {
        query: { limit: 250, cursor },
      })
      all.push(...page.data)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return all
  }

  getWorkflow(id: string) {
    return this.api<N8nWorkflow>("GET", `/workflows/${encodeURIComponent(id)}`)
  }

  createWorkflow(workflow: Pick<N8nWorkflow, "name" | "nodes" | "connections" | "settings" | "staticData">) {
    return this.api<N8nWorkflow>("POST", "/workflows", { body: workflow })
  }

  activateWorkflow(id: string) {
    return this.api<N8nWorkflow>("POST", `/workflows/${encodeURIComponent(id)}/activate`)
  }

  deactivateWorkflow(id: string) {
    return this.api<N8nWorkflow>("POST", `/workflows/${encodeURIComponent(id)}/deactivate`)
  }

  async listCredentials(): Promise<N8nCredential[]> {
    const all: N8nCredential[] = []
    let cursor: string | undefined
    do {
      const page = await this.api<{ data: N8nCredential[]; nextCursor: string | null }>("GET", "/credentials", {
        query: { limit: 250, cursor },
      })
      all.push(...page.data)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return all
  }

  createCredential(credential: { name: string; type: string; data: Record<string, unknown> }) {
    return this.api<N8nCredential>("POST", "/credentials", { body: credential })
  }

  /** The n8n version, from the public frontend settings endpoint. */
  async version(): Promise<string | null> {
    try {
      const res = await this.fetchImpl(this.url("/rest/settings"), { signal: AbortSignal.timeout(this.timeoutMs) })
      if (!res.ok) return null
      const body = (await res.json()) as { data?: { versionCli?: string } }
      return body.data?.versionCli ?? null
    } catch {
      return null
    }
  }
}

/** Probes a health URL: true when it answers 2xx. */
export async function probe(url: string, fetchImpl: FetchLike = fetch, timeoutMs = 10_000) {
  const started = Date.now()
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    return { ok: res.ok, status: res.status, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - started, error: (error as Error).message }
  }
}

export type QueueMetrics = { waiting: number; active: number; completed: number; failed: number }

/** Reads queue gauges from n8n's Prometheus /metrics output. */
export function parseQueueMetrics(text: string): QueueMetrics | null {
  const read = (name: string) => {
    // The prefix is configurable in n8n (N8N_METRICS_PREFIX, default "n8n_"); counters may end in _total.
    const pattern = `^[a-zA-Z0-9_]*scaling_mode_queue_jobs_${name}(?:_total)?(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)$`
    const match = text.match(new RegExp(pattern, "m"))
    return match ? Number(match[1]) : null
  }
  const waiting = read("waiting")
  if (waiting === null) return null
  return { waiting, active: read("active") ?? 0, completed: read("completed") ?? 0, failed: read("failed") ?? 0 }
}

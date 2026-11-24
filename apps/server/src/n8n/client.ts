import { parseVersionMetric, readMetricsText, requestOnce } from "@n8n-ops/shared"

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
  tags?: { id: string; name: string }[]
  nodes: N8nNode[]
  connections: Record<string, { main?: ({ node: string; type: string; index: number }[] | null)[] }>
  settings?: Record<string, unknown>
  staticData?: unknown
  pinData?: unknown
  nodeGroups?: unknown
  description?: string | null
  createdAt?: string
  updatedAt?: string
  versionId?: string
  activeVersionId?: string | null
}

export type N8nCredential = { id: string; name: string; type: string; createdAt?: string }

export type WorkflowBody = Pick<N8nWorkflow, "name" | "nodes" | "connections"> & {
  settings: Record<string, unknown>
} & Partial<Pick<N8nWorkflow, "nodeGroups" | "description" | "pinData">>

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

export const MAX_WORKFLOW_PAGES = 400

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
    {
      query,
      body,
      signal,
    }: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const res = await this.fetchImpl(this.url(`/api/v1${path}`, query), {
      method,
      headers: {
        "X-N8N-API-KEY": this.apiKey,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "manual",
    })
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined)
      throw new N8nError(
        `n8n answered ${res.status} for ${method} ${path}: the instance's address redirects, and n8n-ops does not follow redirects with the API key. Set the address n8n answers at.`,
        res.status,
      )
    }
    const text = await res.text()
    if (!res.ok) throw new N8nError(`n8n answered ${res.status} for ${method} ${path}`, res.status, text.slice(0, 500))
    return (text ? JSON.parse(text) : null) as T
  }

  async discoverScopes(): Promise<string[] | null> {
    try {
      const res = await this.api<{ data?: { scopes?: string[] } }>("GET", "/discover")
      return res.data?.scopes ?? []
    } catch (error) {
      if (error instanceof N8nError && error.status === 404) return null
      throw error
    }
  }

  listErrorExecutions(cursor?: string, limit = 50) {
    return this.api<{ data: N8nExecution[]; nextCursor: string | null }>("GET", "/executions", {
      query: { status: "error", includeData: true, limit, cursor },
    })
  }

  listExecutions(
    query: {
      status?: string
      workflowId?: string
      limit?: number
      cursor?: string
      startedAfter?: string
    },
    signal?: AbortSignal,
  ) {
    return this.api<{ data: N8nExecution[]; nextCursor: string | null }>("GET", "/executions", { query, signal })
  }

  getExecution(id: string) {
    return this.api<N8nExecution>("GET", `/executions/${encodeURIComponent(id)}`, { query: { includeData: true } })
  }

  async listWorkflows(name?: string, signal?: AbortSignal): Promise<N8nWorkflow[]> {
    const all: N8nWorkflow[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let pages = 1; ; pages++) {
      signal?.throwIfAborted()
      const page = await this.api<{ data: N8nWorkflow[]; nextCursor: string | null }>("GET", "/workflows", {
        query: { limit: 250, cursor, name },
        signal,
      })
      all.push(...page.data)
      cursor = page.nextCursor ?? undefined
      if (!cursor) return all
      if (seen.has(cursor)) throw new Error("n8n repeated a page cursor while listing workflows")
      if (pages >= MAX_WORKFLOW_PAGES) throw new Error(`n8n listed more than ${MAX_WORKFLOW_PAGES} pages of workflows`)
      seen.add(cursor)
    }
  }

  getWorkflow(id: string) {
    return this.api<N8nWorkflow>("GET", `/workflows/${encodeURIComponent(id)}`)
  }

  createWorkflow(
    workflow: WorkflowBody | Pick<N8nWorkflow, "name" | "nodes" | "connections" | "settings" | "staticData">,
  ) {
    return this.api<N8nWorkflow>("POST", "/workflows", { body: workflow })
  }

  updateWorkflow(id: string, workflow: WorkflowBody, options: { publishIfActive?: boolean } = {}) {
    return this.api<N8nWorkflow>("PUT", `/workflows/${encodeURIComponent(id)}`, {
      query: { publishIfActive: options.publishIfActive },
      body: workflow,
    })
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

  async version(metricsUrl?: string | null): Promise<string | null> {
    try {
      const res = await this.fetchImpl(this.url("/rest/settings"), { signal: AbortSignal.timeout(this.timeoutMs) })
      if (res.ok) {
        const body = (await res.json()) as { data?: { versionCli?: string } }
        if (body.data?.versionCli) return body.data.versionCli
      }
    } catch {}
    try {
      const res = await this.fetchImpl(metricsUrl || this.url("/metrics"), {
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      return res.ok ? parseVersionMetric(await readMetricsText(res)) : null
    } catch {
      return null
    }
  }
}

export function probe(url: string, fetchImpl: FetchLike = fetch, timeoutMs = 10_000) {
  return requestOnce(url, AbortSignal.timeout(timeoutMs), fetchImpl)
}

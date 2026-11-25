import {
  keepPreviousData,
  QueryClient,
  type QueryFilters,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useKeptRows } from "@/lib/load-state"
import { sessionEnded, sessionEnding } from "@/lib/session"
import { toast } from "@/lib/toast"

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly issues?: { path: (string | number)[]; message: string }[],
    readonly detail?: string,
    readonly reason?: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(detail ?? (issues?.length ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : code))
  }
}

export const UNREACHABLE_TEXT = "Could not reach n8n-ops. Check your connection and try again."

export class NetworkError extends Error {
  constructor() {
    super(UNREACHABLE_TEXT)
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init
  const unreached = (e: unknown) => {
    if (rest.signal?.reason instanceof DOMException && rest.signal.reason.name === "TimeoutError")
      return new NetworkError()
    if (rest.signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) return e
    return new NetworkError()
  }
  let res: Response
  let text: string
  try {
    res = await fetch(`/api${path}`, {
      credentials: "same-origin",
      ...rest,
      headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    })
    text = await res.text()
  } catch (e) {
    throw unreached(e)
  }
  const body = text ? safeJson(text) : null
  const b = body as { error?: string; issues?: ApiError["issues"]; message?: string; reason?: string } | null
  if (res.status === 401) sessionEnded(b?.reason)
  if (!res.ok)
    throw new ApiError(
      res.status,
      b?.error ?? `http_${res.status}`,
      b?.issues,
      b?.message,
      b?.reason,
      b && typeof b === "object" ? (b as Record<string, unknown>) : undefined,
    )
  return body as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
})

export function readAfterSave(filters: QueryFilters, client: QueryClient = queryClient): Promise<void> {
  void client.cancelQueries(filters, { silent: true })
  return client.invalidateQueries(filters)
}

export class RefreshError extends Error {
  constructor() {
    super("refresh_failed")
  }
}

export async function refreshAreas(...prefixes: string[]): Promise<void> {
  const predicate: QueryFilters["predicate"] = ({ queryKey: [key] }) =>
    typeof key === "string" && prefixes.some((p) => key.startsWith(p))
  await readAfterSave({ predicate })
  const failed = queryClient
    .getQueryCache()
    .findAll({ predicate, type: "active" })
    .filter((q) => q.state.status === "error")
  if (failed.length > 0) throw new RefreshError()
}

export function useApi<T>(path: string | null, options: { refetchInterval?: number; keepRows?: boolean } = {}) {
  const query = useQuery<T>({
    queryKey: [path],
    queryFn: () => api<T>(path as string),
    enabled: path !== null,
    refetchInterval: options.refetchInterval,
    placeholderData: options.keepRows ? keepPreviousData : undefined,
  })
  return useKeptRows(path, query, Boolean(options.keepRows))
}

type ToastText<TBody> = string | ((body: TBody) => string)

export function failureText(failed: string | undefined, error: unknown): string {
  return failed ? `Could not ${failed}: ${describeError(error)}` : describeError(error)
}

export function useApiMutation<TBody, TResult = unknown>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string | ((body: TBody) => string),
  {
    invalidate = [],
    success,
    failed,
    quiet = false,
  }: { invalidate?: string[]; success?: ToastText<TBody>; failed?: ToastText<TBody>; quiet?: boolean } = {},
) {
  const client = useQueryClient()
  return useMutation<TResult, Error, TBody>({
    mutationFn: (body) =>
      api<TResult>(typeof path === "function" ? path(body) : path, {
        method,
        json: method === "DELETE" ? undefined : body,
      }),
    onSuccess: (_, body) => {
      for (const key of invalidate) void readAfterSave({ queryKey: [key] }, client)
      if (success) toast.success(typeof success === "function" ? success(body) : success)
    },
    onError: (error, body) => {
      if (!quiet && !sessionEnding())
        toast.error(failureText(typeof failed === "function" ? failed(body) : failed, error))
    },
  })
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const known: Record<string, string> = {
      unauthorized: "Your session ended. Sign in again.",
      totp_required: "Set up two-factor authentication first.",
      not_found: "Not found.",
      internal_error: "Something went wrong on the server. Check the server logs.",
    }
    const said = error.detail ?? known[error.code]
    if (said) return said
    if (error.code === `http_${error.status}` && !error.issues?.length)
      return [502, 503, 504].includes(error.status)
        ? "n8n-ops did not answer. Try again in a moment."
        : `The server answered with error ${error.status}.`
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

import { keepPreviousData, QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "@/lib/toast"

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly issues?: { path: (string | number)[]; message: string }[],
    /** Human explanation sent by the server, when it has one. */
    readonly detail?: string,
  ) {
    super(detail ?? (issues?.length ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : code))
  }
}

/** Calls the n8n-ops API. Sends the session cookie; throws ApiError with the server's error code. */
export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
  const text = await res.text()
  const body = text ? safeJson(text) : null
  if (!res.ok) {
    const b = body as { error?: string; issues?: ApiError["issues"]; message?: string } | null
    throw new ApiError(res.status, b?.error ?? `http_${res.status}`, b?.issues, b?.message)
  }
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

/*
 * A read that started before a save of the same path must not bring back what the save replaced: React Query
 * can still write such an answer after the save has invalidated the path. Each successful save moves the
 * path's epoch on; an answer to a read from an earlier epoch is dropped in favour of what the cache holds.
 */
const epochs = new Map<string, number>()

/** Marks a path as just saved, so reads that started before are not trusted. */
export function markSaved(path: string) {
  epochs.set(path, (epochs.get(path) ?? 0) + 1)
}

/** Reads a path for the query cache, dropping an answer that a save overtook. */
export async function readFresh<T>(path: string, client: QueryClient = queryClient): Promise<T> {
  let data: T
  // A few tries at most: an overtaken answer is replaced by the cache, or, with nothing cached yet, read again.
  for (let attempt = 0; ; attempt++) {
    const started = epochs.get(path) ?? 0
    data = await api<T>(path)
    if ((epochs.get(path) ?? 0) === started || attempt === 2) return data
    const cached = client.getQueryData<T>([path])
    if (cached !== undefined) return cached
  }
}

/**
 * Reads an API path. With `keepRows` a list whose filters change keeps showing its last rows until the new
 * answer arrives (`isPlaceholderData` is true meanwhile), instead of dropping to a loading state (TB-5).
 */
export function useApi<T>(path: string | null, options: { refetchInterval?: number; keepRows?: boolean } = {}) {
  return useQuery<T>({
    queryKey: [path],
    queryFn: () => readFresh<T>(path as string),
    enabled: path !== null,
    refetchInterval: options.refetchInterval,
    placeholderData: options.keepRows ? keepPreviousData : undefined,
  })
}

/** A mutation that shows a toast on error and invalidates the given query paths on success. */
export function useApiMutation<TBody, TResult = unknown>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string | ((body: TBody) => string),
  { invalidate = [], success }: { invalidate?: string[]; success?: string } = {},
) {
  const client = useQueryClient()
  return useMutation<TResult, Error, TBody>({
    mutationFn: (body) =>
      api<TResult>(typeof path === "function" ? path(body) : path, {
        method,
        json: method === "DELETE" ? undefined : body,
      }),
    onSuccess: () => {
      for (const key of invalidate) {
        markSaved(key)
        void client.invalidateQueries({ queryKey: [key] })
      }
      if (success) toast.success(success)
    },
    onError: (error) => toast.error(describeError(error)),
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
    return error.detail ?? known[error.code] ?? error.message
  }
  return error instanceof Error ? error.message : String(error)
}

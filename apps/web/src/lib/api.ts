import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly issues?: { path: (string | number)[]; message: string }[],
  ) {
    super(issues?.length ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : code)
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
    const b = body as { error?: string; issues?: ApiError["issues"] } | null
    throw new ApiError(res.status, b?.error ?? `http_${res.status}`, b?.issues)
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

export function useApi<T>(path: string | null, options: { refetchInterval?: number } = {}) {
  return useQuery<T>({
    queryKey: [path],
    queryFn: () => api<T>(path as string),
    enabled: path !== null,
    refetchInterval: options.refetchInterval,
  })
}

/** A mutation that shows a toast on error and invalidates the given query paths on success. */
export function useApiMutation<TBody, TResult = unknown>(
  method: "POST" | "PUT" | "DELETE",
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
      for (const key of invalidate) void client.invalidateQueries({ queryKey: [key] })
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
    return known[error.code] ?? error.message
  }
  return error instanceof Error ? error.message : String(error)
}

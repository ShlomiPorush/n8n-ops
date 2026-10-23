import { keepPreviousData, QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useKeptRows } from "@/lib/load-state"
import { sessionEnded, sessionEnding } from "@/lib/session"
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

/** What to say when a request never reached the server: offline, or the server is down (FS-23). */
export const UNREACHABLE_TEXT = "Could not reach n8n-ops. Check your connection and try again."

/** A request that got no answer, or lost it on the way. Not an ApiError, so reads are still retried. */
export class NetworkError extends Error {
  constructor() {
    super(UNREACHABLE_TEXT)
  }
}

/** Calls the n8n-ops API. Sends the session cookie; throws ApiError with the server's error code. */
export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init
  // A request the page called off stays an abort; anything else got no whole answer from the server.
  const unreached = (e: unknown) => {
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
    // The connection can also drop after the headers, while the body is read.
    text = await res.text()
  } catch (e) {
    throw unreached(e)
  }
  const body = text ? safeJson(text) : null
  // The session ended on an open page: sign in again and come back here (NL-18).
  if (res.status === 401) sessionEnded()
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

/** A refresh after a change that left a read on screen with its old data, so the caller can offer Refresh (FB-16). */
export class RefreshError extends Error {
  constructor() {
    super("refresh_failed")
  }
}

/**
 * Refreshes every cached read under the given paths, lists with any filters included ("/problems" covers
 * "/problems?status=open" and "/problems/3f2a"), and marks them saved so an older answer cannot come back.
 * Settles once the reads on screen have answered; rejects with RefreshError when one of them failed, since React
 * Query keeps the old data then and does not reject by itself.
 */
export async function refreshAreas(...prefixes: string[]): Promise<void> {
  const under = (key: unknown): key is string => typeof key === "string" && prefixes.some((p) => key.startsWith(p))
  for (const query of queryClient.getQueryCache().getAll()) {
    const key = query.queryKey[0]
    if (under(key)) markSaved(key)
  }
  await queryClient.invalidateQueries({ predicate: (q) => under(q.queryKey[0]) })
  const failed = queryClient
    .getQueryCache()
    .findAll({ predicate: (q) => under(q.queryKey[0]) && q.isActive() && q.state.status === "error" })
  if (failed.length > 0) throw new RefreshError()
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
 * answer arrives (`isPlaceholderData` is true meanwhile), instead of dropping to a loading state (TB-5), and keeps
 * them when that answer fails (`previous` says so, `keepShown` in lib/load-state.ts). A refresh that fails keeps
 * `data` and sets `error` beside it: pages draw it through `loadView`.
 */
export function useApi<T>(path: string | null, options: { refetchInterval?: number; keepRows?: boolean } = {}) {
  const query = useQuery<T>({
    queryKey: [path],
    queryFn: () => readFresh<T>(path as string),
    enabled: path !== null,
    refetchInterval: options.refetchInterval,
    placeholderData: options.keepRows ? keepPreviousData : undefined,
  })
  return useKeptRows(path, query, Boolean(options.keepRows))
}

/** A toast text, or one built from the request body when it names the object ("Checked n8n-1 now"). */
type ToastText<TBody> = string | ((body: TBody) => string)

/** The error toast of a request: what failed, then why ("Could not resolve Sync orders: Not found.", FB-3). */
export function failureText(failed: string | undefined, error: unknown): string {
  return failed ? `Could not ${failed}: ${describeError(error)}` : describeError(error)
}

/**
 * A mutation that shows a toast on error and invalidates the given query paths on success. Toasts name the object
 * and the result (FB-4): `success` is the whole text ("Problem resolved: Sync orders"), `failed` what could not be
 * done ("resolve Sync orders" reads "Could not resolve Sync orders: <reason>", FB-3). Either may be a function of
 * the body, read when the request ends. With `quiet` the caller says what failed itself, such as the save bar
 * naming each area (SV-3).
 */
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
      for (const key of invalidate) {
        markSaved(key)
        void client.invalidateQueries({ queryKey: [key] })
      }
      if (success) toast.success(typeof success === "function" ? success(body) : success)
    },
    // On the way to sign-in after the session ended, no error toast is shown (NL-18).
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
    // An answer without our error body came from something in between, such as a proxy whose n8n-ops is down:
    // say that in words, not "http_502" (FB-3). It follows "Could not …: ", so it does not start that way too.
    if (error.code === `http_${error.status}` && !error.issues?.length)
      return [502, 503, 504].includes(error.status)
        ? "n8n-ops did not answer. Try again in a moment."
        : `The server answered with error ${error.status}.`
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

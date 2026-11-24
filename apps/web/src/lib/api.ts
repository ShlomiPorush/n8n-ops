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
    /** Human explanation sent by the server, when it has one. */
    readonly detail?: string,
    /** Why the server ended the session, on a 401 `session_ended` (idle, max, lifetime, signed_out). */
    readonly reason?: string,
    /** The whole answer, for fields a page reads itself (the socket proxy fix of a failed export). */
    readonly body?: Record<string, unknown>,
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
    // A read that got no answer in its time (`AbortSignal.timeout`) got no answer at all.
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
    // The connection can also drop after the headers, while the body is read.
    text = await res.text()
  } catch (e) {
    throw unreached(e)
  }
  const body = text ? safeJson(text) : null
  const b = body as { error?: string; issues?: ApiError["issues"]; message?: string; reason?: string } | null
  // The session ended on an open page: sign in again and come back here (NL-18), told why when the server says.
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

/**
 * Reads the matching queries on screen again after a save. A read on its way started before the save, so it is called
 * off and its answer cannot bring back what the save replaced, also for a query that is not read again now.
 * `silent`: whoever waits for the read called off waits for the new one.
 */
export function readAfterSave(filters: QueryFilters, client: QueryClient = queryClient): Promise<void> {
  void client.cancelQueries(filters, { silent: true })
  return client.invalidateQueries(filters)
}

/** A refresh after a change that left a read on screen with its old data, so the caller can offer Refresh (FB-16). */
export class RefreshError extends Error {
  constructor() {
    super("refresh_failed")
  }
}

/**
 * Refreshes every cached read under the given paths, lists with any filters included ("/problems" covers
 * "/problems?status=open" and "/problems/3f2a"), and drops their older answers (`readAfterSave`).
 * Settles once the reads on screen have answered; rejects with RefreshError when one of them failed, since React
 * Query keeps the old data then and does not reject by itself.
 */
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

/**
 * Reads an API path. With `keepRows` a list whose filters change keeps showing its last rows until the new
 * answer arrives (`isPlaceholderData` is true meanwhile), instead of dropping to a loading state (TB-5), and keeps
 * them when that answer fails (`previous` says so, `keepShown` in lib/load-state.ts). A refresh that fails keeps
 * `data` and sets `error` beside it: pages draw it through `loadView`.
 */
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
      for (const key of invalidate) void readAfterSave({ queryKey: [key] }, client)
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

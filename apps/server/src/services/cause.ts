import { sha256 } from "../lib/crypto.ts"

/**
 * The cause of a failed execution: what the failing node talked to (the target) and what went wrong there (the
 * reason), read by fixed rules from what n8n stores with the execution (docs/adr/0003). No rule here calls out or
 * guesses: an unknown error keeps n8n's own words. Every function is total: content from n8n or from the services it
 * called never makes it throw, it only falls back to a weaker rule.
 */

export type CauseKind = "alert" | "runner" | "sub" | "cert" | "net" | "cred" | "svc" | "req" | "other"
export type TargetSource = "workflow" | "host" | "credential" | "error-host" | "node"

/** What the cause is read from: the failure (see `extractFailure`) and where it happened. */
export type CauseInput = {
  instanceId: string
  workflowId: string
  nodeName: string
  nodeType: string | null
  message: string
  description: string | null
  /** The node's `url` parameter when it is a string. */
  url: string | null
  /** The node's credentials that have both an id and a name. */
  credentials: { id: string; name: string }[]
  /** For an Execute Workflow node: the workflow it runs, when its id is literal. */
  calledWorkflow: { id: string; name: string | null } | null
}

export type Cause = {
  /** Stable: the same target keeps its key when it is renamed. */
  targetKey: string
  /** What screens and messages show. */
  target: string
  targetSource: TargetSource
  /** The full reason; with the target key it makes the cause key. */
  reason: string
  /** The reason shortened for screens. */
  displayReason: string
  httpStatus: number | null
  kind: CauseKind
  /** One line from the table of known errors, or null. */
  hint: string | null
  key: string
}

/** Inputs are cut to these lengths before any parsing. */
export const LIMITS = { message: 2048, description: 8192, url: 2048 } as const
const JSON_DEPTH = 4
const DISPLAY_MAX = 300

/** n8n's fixed text for an HTTP status (its NodeApiError messages), by the start of the message. */
const HTTP_MESSAGES: [number, string][] = [
  [400, "Bad request - please check your parameters"],
  [401, "Authorization failed - please check your credentials"],
  [403, "Forbidden - perhaps check your credentials?"],
  [404, "The resource you are requesting could not be found"],
  [429, "The service is receiving too many requests from you"],
  [500, "The service was not able to process your request"],
  [502, "Bad gateway - the service failed to handle your request"],
  [503, "Service unavailable - try again later"],
  [504, "Gateway timed out - perhaps try again later?"],
]

const NETWORK =
  /ENETUNREACH|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|ENOTFOUND|DNS server|host is unreachable|connection timed out|connection was aborted|closed unexpectedly|Timeout while connecting/i
const RUNNER = /not matched to a runner|Task request timed out/i
const SIGN_IN = /Auth Error|Access denied|Client authentication failed|invalid_client|AADSTS/i

/** One line for an error everyone meets; the first pattern that matches wins. */
const KNOWN_ERRORS: [RegExp, string][] = [
  [/certificate has expired/i, "The server's TLS certificate has expired."],
  [/AADSTS7000222/, "The client secret of the Microsoft Entra app has expired."],
  [/Client authentication failed/i, "The OAuth app's client ID or secret was rejected."],
  [/ENETUNREACH/, "No network route to the server."],
  [/DNS server returned an error|EAI_AGAIN|ENOTFOUND/i, "The server name could not be resolved."],
  [/host is unreachable/i, "The server could not be reached."],
  [RUNNER, "The n8n task runner did not take the Code node's task. A problem of the instance, not the workflow."],
  [/is no longer available/i, "The provider no longer offers what the node asks for."],
  [/^HTML page\b|· HTML page\b/, "A proxy answered instead of the service."],
]

const isStopAndError = (type: string | null) => !!type && /\.stopAndError$/.test(type)
const isExecuteWorkflow = (type: string | null) => !!type && /\.executeWorkflow$/.test(type)

/** The host of a URL that is literal up to the host, also in an expression that starts with it. */
export function hostOf(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null
  const m = url
    .slice(0, LIMITS.url)
    .trim()
    .replace(/^=/, "")
    .match(/^https?:\/\/(?:[^@/?#\s{}]*@)?([^/:?#\s{}]+)/i)
  return m?.[1] ? m[1].toLowerCase() : null
}

function httpStatusOf(message: string, description: string | null): number | null {
  const fixed = HTTP_MESSAGES.find(([, text]) => message.startsWith(text))
  if (fixed) return fixed[0]
  const m = description?.match(/^(\d{3}) - /)
  return m ? Number(m[1]) : null
}

/** The first non-empty `error`, `message` or `reason` string in a parsed body, looked for down to JSON_DEPTH. */
function pickText(value: unknown, depth = 0): string | null {
  if (depth > JSON_DEPTH || !value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  for (const k of ["error", "message", "reason"]) {
    const v = record[k]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  for (const v of Object.values(record)) {
    const found = pickText(v, depth + 1)
    if (found) return found
  }
  return null
}

/**
 * Plain text from a service's answer: tags dropped, and then every angle bracket left over, so that nothing that looks
 * like markup ("<<b>script>") survives. A reason is text; screens and messages escape it as well.
 */
const stripTags = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .trim()

/**
 * The service's own answer in n8n's error description: plain text, the text of a JSON body (n8n writes "NNN - body"),
 * the Code and Message of an XML error, or the title of an HTML page. Null when it holds nothing usable.
 */
export function serviceAnswer(description: string | null): string | null {
  if (typeof description !== "string") return null
  const s = description.slice(0, LIMITS.description).trim()
  if (!s) return null
  if (/^(<!doctype html|<html)/i.test(s)) {
    const title = s.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim()
    return title ? `HTML page "${title}"` : "HTML page"
  }
  if (/^(<\?xml|<Error\b)/i.test(s)) {
    const code = s.match(/<Code>([^<]*)<\/Code>/i)?.[1]?.trim()
    const message = s.match(/<Message>([^<\n]*)/i)?.[1]?.trim()
    const text = [code, message].filter(Boolean).join(": ")
    return text || null
  }
  const body = s.match(/^\d{3} - ([\s\S]*)$/)
  if (body) {
    let value: unknown = body[1]
    for (let i = 0; i < 2 && typeof value === "string"; i++) {
      try {
        value = JSON.parse(value)
      } catch {
        break
      }
    }
    if (typeof value === "string") return stripTags(value) || null
    return pickText(value)
  }
  return stripTags(s) || null
}

/** Replaces what changes from one failure to the next without changing what went wrong. */
export function normalize(reason: string): string {
  return reason
    .replace(/\b(RequestId|Request ID|Trace ID|Correlation ID|Timestamp)\s*:[^\n]*/gi, "$1: <id>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
}

/** The reason as screens show it: wrapper tags and long asides dropped, then its first sentence, at most 300. */
export function displayReasonOf(reason: string): string {
  let s = reason
    .replace(/(\[[^\]\n]{1,80}\]:?\s*)+/g, "")
    .replace(/Error fetching from \S+:\s+/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (s.length > 100) s = s.replace(/\s*\([^)]*\)/g, "")
  if (s.length > 120) {
    const sentence = s.match(/^([\s\S]{20,}?[.!?])(\s|$)/)
    if (sentence?.[1]) s = sentence[1]
  }
  if (s.length > DISPLAY_MAX) s = `${s.slice(0, DISPLAY_MAX - 1).trimEnd()}…`
  return s || reason.slice(0, DISPLAY_MAX)
}

function kindOf(input: CauseInput, httpStatus: number | null, text: string): CauseKind {
  if (isStopAndError(input.nodeType)) return "alert"
  if (RUNNER.test(text)) return "runner"
  if (isExecuteWorkflow(input.nodeType)) return "sub"
  if (/certificate/i.test(input.message)) return "cert"
  if (NETWORK.test(input.message)) return "net"
  if (httpStatus === 401 || httpStatus === 403 || SIGN_IN.test(text)) return "cred"
  if (httpStatus !== null && httpStatus >= 500) return "svc"
  if (httpStatus !== null && httpStatus >= 400) return "req"
  return "other"
}

function targetOf(input: CauseInput): Pick<Cause, "targetKey" | "target" | "targetSource"> {
  const called = input.calledWorkflow
  if (isExecuteWorkflow(input.nodeType) && called?.id)
    return {
      targetKey: `workflow:${input.instanceId}:${called.id}`,
      target: called.name ? `Runs "${called.name}"` : `Runs workflow ${called.id}`,
      targetSource: "workflow",
    }
  const host = hostOf(input.url)
  if (host) return { targetKey: `host:${host}`, target: host, targetSource: "host" }
  const credential = input.credentials[0]
  if (credential)
    return {
      targetKey: `credential:${input.instanceId}:${credential.id}`,
      target: credential.name,
      targetSource: "credential",
    }
  if (input.url === null && typeof input.description === "string") {
    const named = hostOf(input.description.slice(0, LIMITS.description).match(/https?:\/\/[^\s'"<>]+/)?.[0])
    if (named) return { targetKey: `host:${named}`, target: named, targetSource: "error-host" }
  }
  return nodeTarget(input)
}

const nodeTarget = (input: Pick<CauseInput, "instanceId" | "workflowId" | "nodeName">) => ({
  targetKey: `node:${input.instanceId}:${input.workflowId}:${input.nodeName}`,
  target: input.nodeName,
  targetSource: "node" as const,
})

const keyOf = (targetKey: string, reason: string) => sha256(`${targetKey}\n${normalize(reason)}`)

/** The cause of one failed execution. Never throws: anything unexpected gives the node and the error text. */
export function causeOf(input: CauseInput): Cause {
  try {
    const message = (typeof input.message === "string" ? input.message : "").slice(0, LIMITS.message).trim()
    const safe: CauseInput = {
      ...input,
      message,
      description: typeof input.description === "string" ? input.description : null,
      url: typeof input.url === "string" ? input.url : null,
      credentials: Array.isArray(input.credentials) ? input.credentials : [],
    }
    const httpStatus = httpStatusOf(message, safe.description)
    const answer = serviceAnswer(safe.description)
    const reason = httpStatus
      ? answer && !answer.startsWith(String(httpStatus))
        ? `HTTP ${httpStatus} · ${answer}`
        : `HTTP ${httpStatus}`
      : answer || message || "Unknown error"
    const target = targetOf(safe)
    const kind = kindOf(safe, httpStatus, `${message} ${safe.description?.slice(0, LIMITS.description) ?? ""}`)
    const hintText = `${message} ${answer ?? ""} ${reason}`
    const hint = KNOWN_ERRORS.find(([pattern]) => pattern.test(hintText))?.[1] ?? null
    return {
      ...target,
      reason,
      displayReason: displayReasonOf(reason),
      httpStatus,
      kind,
      hint,
      key: keyOf(target.targetKey, reason),
    }
  } catch {
    return fallbackCause(input)
  }
}

/** The cause when nothing else can be read: the node and the error text as n8n gave it. */
export function fallbackCause(input: Pick<CauseInput, "instanceId" | "workflowId" | "nodeName" | "message">): Cause {
  const nodeName = typeof input.nodeName === "string" && input.nodeName ? input.nodeName : "Workflow"
  const target = nodeTarget({ instanceId: input.instanceId, workflowId: input.workflowId, nodeName })
  const raw = typeof input.message === "string" ? input.message.slice(0, LIMITS.message).trim() : ""
  const reason = raw || "Unknown error"
  return {
    ...target,
    reason,
    displayReason: reason.slice(0, DISPLAY_MAX),
    httpStatus: null,
    kind: "other",
    hint: null,
    key: keyOf(target.targetKey, reason),
  }
}

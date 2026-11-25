import { sha256 } from "../lib/crypto.ts"
import { storableText } from "../lib/storable.ts"

export type CauseKind = "alert" | "runner" | "sub" | "cert" | "net" | "cred" | "svc" | "req" | "other"
export type TargetSource = "workflow" | "host" | "credential" | "error-host" | "node"

export type CauseInput = {
  instanceId: string
  workflowId: string
  nodeName: string
  nodeType: string | null
  message: string
  description: string | null
  url: string | null
  credentials: { id: string; name: string }[]
  calledWorkflow: { id: string; name: string | null } | null
}

export type Cause = {
  targetKey: string
  target: string
  targetSource: TargetSource
  reason: string
  displayReason: string
  httpStatus: number | null
  kind: CauseKind
  hint: string | null
  key: string
}

export const LIMITS = { message: 2048, description: 8192, url: 2048 } as const
const JSON_DEPTH = 4
const DISPLAY_MAX = 300

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

const KNOWN_ERRORS: [RegExp, string][] = [
  [/certificate has expired/i, "The server's TLS certificate has expired."],
  [/AADSTS7000222/, "The client secret of the Microsoft Entra app has expired."],
  [/Client authentication failed/i, "The OAuth app's client ID or secret was rejected."],
  [/ENETUNREACH/, "No network route to the server."],
  [/DNS server returned an error|EAI_AGAIN|ENOTFOUND/i, "The server name could not be resolved."],
  [/host is unreachable/i, "The server could not be reached."],
  [RUNNER, "The n8n task runner did not take the Code node's task. A problem of the instance, not the workflow."],
  [/is no longer available/i, "The provider no longer offers what the node asks for."],
  [/(?:^|\s)HTML page(?: "|$|\s)/, "A proxy answered instead of the service."],
]

export function knownErrorOf(message: string, reason: string): string | null {
  const text = `${message.slice(0, LIMITS.message)} ${reason.slice(0, LIMITS.description)}`
  return KNOWN_ERRORS.find(([pattern]) => pattern.test(text))?.[1] ?? null
}

const isStopAndError = (type: string | null) => !!type && /\.stopAndError$/.test(type)
const isExecuteWorkflow = (type: string | null) => !!type && /\.executeWorkflow$/.test(type)

export function hostOf(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null
  const m = url
    .slice(0, LIMITS.url)
    .trim()
    .replace(/^=/, "")
    .match(/^https?:\/\/([^/?#\s]*)/i)
  let authority = m?.[1] ?? ""
  if (!authority || /[{}$]/.test(authority)) return null
  authority = authority.slice(authority.lastIndexOf("@") + 1)
  if (authority.startsWith("[")) {
    const ipv6 = authority.match(/^\[[0-9a-f:.]+\]/i)?.[0]
    return ipv6 ? ipv6.toLowerCase() : null
  }
  const host = authority.replace(/:\d*$/, "").toLowerCase()
  return /^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.?$/.test(host) ? host : null
}

function httpStatusOf(message: string, description: string | null): number | null {
  const fixed = HTTP_MESSAGES.find(([, text]) => message.startsWith(text))
  if (fixed) return fixed[0]
  const m = description?.match(/^(\d{3}) - /)
  return m ? Number(m[1]) : null
}

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

function stripTags(s: string): string {
  let out = ""
  let tag: string | null = null
  for (const ch of s) {
    if (tag === null) {
      if (ch === "<") tag = ""
      else if (ch !== ">") out += ch
    } else if (ch === ">") {
      if (/^\/?br\b/i.test(tag)) out += " "
      tag = null
    } else if (ch !== "<") tag += ch
  }
  return (tag === null ? out : out + tag).trim()
}

export function serviceAnswer(description: string | null): string | null {
  const answer = readAnswer(description)
  return answer === null ? null : storableText(answer) || null
}

function readAnswer(description: string | null): string | null {
  if (typeof description !== "string") return null
  let s = description.slice(0, LIMITS.description).trim()
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
    if (typeof value !== "string") return pickText(value)
    s = value.trim()
  }
  return markupAnswer(s) ?? (stripTags(s) || null)
}

function markupAnswer(s: string): string | null {
  if (/^(<!doctype html|<html)/i.test(s)) {
    const title = stripTags(s.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "")
    return title ? `HTML page "${title}"` : "HTML page"
  }
  if (/^(<\?xml|<Error\b)/i.test(s)) {
    const code = stripTags(s.match(/<Code>([^<]*)<\/Code>/i)?.[1] ?? "")
    const message = stripTags(s.match(/<Message>([\s\S]*?)(?:<\/Message>|$)/i)?.[1] ?? "")
    return [code, message].filter(Boolean).join(": ") || null
  }
  return null
}

export function normalize(reason: string): string {
  return reason
    .replace(/\b(RequestId|Request ID|Trace ID|Correlation ID|Timestamp)\s*:[^\n]*/gi, "$1: <id>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
}

export function displayReasonOf(reason: string): string {
  let s = reason.replace(/\s+/g, " ").trim()
  if (s.length > 100)
    s = s
      .replace(/(\[[^\]]{1,80}\]:?\s*)+/g, "")
      .replace(/Error fetching from \S+:\s+/g, "")
      .replace(/\s*\([^)]*\)/g, "")
      .trim()
  if (s.length > 120) {
    const sentence = s.match(/^([\s\S]+?[.!?])(\s|$)/)
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

export function causeOf(input: CauseInput): Cause {
  try {
    const message = input.message.slice(0, LIMITS.message).trim()
    const httpStatus = httpStatusOf(message, input.description)
    const answer = serviceAnswer(input.description)
    const said = answer || message || "Unknown error"
    const reason = httpStatus ? `HTTP ${httpStatus} · ${said}` : said
    const target = targetOf(input)
    const text = `${message} ${input.description?.slice(0, LIMITS.description) ?? ""}`
    const kind = kindOf({ ...input, message }, httpStatus, text)
    const hint = knownErrorOf(message, reason)
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

function fallbackCause(input: Pick<CauseInput, "instanceId" | "workflowId" | "nodeName" | "message">): Cause {
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

export type CauseFields = {
  title: string
  target: string | null
  targetSource: TargetSource | null
  reason: string | null
  kind: CauseKind | null
  hint: string | null
}

export function causeFields(row: {
  errorMessage: string
  target: string | null
  targetSource: TargetSource | null
  reason: string | null
  kind: CauseKind | null
}): CauseFields {
  const reason = row.reason ? displayReasonOf(row.reason) : null
  return {
    title: row.target && reason ? `${row.target} · ${reason}` : row.errorMessage,
    target: row.target,
    targetSource: row.targetSource,
    reason,
    kind: row.kind,
    hint: row.reason ? knownErrorOf(row.errorMessage, row.reason) : null,
  }
}

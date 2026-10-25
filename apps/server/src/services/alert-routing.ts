import vm from "node:vm"
import type { TelegramRoute } from "../lib/settings.ts"
import { html, type InlineButton, isTopicGone, type Telegram, type TelegramHtml } from "./telegram.ts"

/** What an alert is about. Health and backup alerts know only the instance; the n8n-ops backup not even that. */
export type AlertSubject = { instanceId?: string; workflowName?: string; tags?: string[] }

/** The subject of an alert about an instance, or about n8n-ops itself (null), which only the default topic takes. */
export const instanceSubject = (instanceId: string | null): AlertSubject => (instanceId ? { instanceId } : {})

/**
 * Workflow patterns run in a separate V8 context with a time limit, so a pattern that backtracks without end
 * (`^(a+)+$` against a long name) stops after PATTERN_MS instead of holding the server. The pattern and the name go
 * in as data, never as code, and the match runs synchronously inside `runInContext`, which the limit covers.
 */
const PATTERN_MS = 20
const sandbox = vm.createContext(Object.create(null))
const matcher = new vm.Script("new RegExp(pattern, 'iu').test(subject)")

/** Patterns that ran out of time once. They match nothing until the server restarts, so each costs PATTERN_MS once. */
const slowPatterns = new Set<string>()

function patternMatches(pattern: string, subject: string, onSlow: (pattern: string) => void) {
  if (slowPatterns.has(pattern)) return false
  sandbox.pattern = pattern
  sandbox.subject = subject.slice(0, 1000)
  try {
    return matcher.runInContext(sandbox, { timeout: PATTERN_MS }) === true
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      slowPatterns.add(pattern)
      onSlow(pattern)
    }
    return false
  }
}

const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0

/** Whether every condition the route sets holds. A condition the subject cannot answer does not hold. */
export function routeMatches(
  route: TelegramRoute,
  subject: AlertSubject,
  onSlow: (pattern: string) => void = () => {},
) {
  if (route.instanceId && route.instanceId !== subject.instanceId) return false
  if (route.tag) {
    const tag = route.tag
    if (!subject.tags?.some((t) => same(t, tag))) return false
  }
  if (
    route.workflow &&
    (subject.workflowName === undefined || !patternMatches(route.workflow, subject.workflowName, onSlow))
  )
    return false
  return true
}

/** The topic for an alert: the first matching route, else the default topic, else null (the General topic). */
export function resolveThread(
  config: { routes: TelegramRoute[]; defaultThreadId: number | null },
  subject: AlertSubject,
  onSlow?: (pattern: string) => void,
): number | null {
  for (const route of config.routes) if (routeMatches(route, subject, onSlow)) return route.threadId
  return config.defaultThreadId
}

/** The line that says a message went to General because its topic is gone. */
export const topicGoneNote = (threadId: number) =>
  html`<i>Topic ${threadId} was not found, so this went to General.</i>`

export type Sent = { messageId: number; threadId: number | null; fellBack: boolean }

/**
 * Sends into the topic. When Telegram refuses the topic itself (deleted, closed), sends once more to General with
 * `render` given the note; any other failure (timeout, 429, HTML, rights) is passed on for the usual retry.
 */
export async function sendRouted(
  api: Telegram,
  chatId: string,
  threadId: number | null,
  render: (note?: TelegramHtml) => TelegramHtml,
  buttons: InlineButton[][] = [],
): Promise<Sent> {
  try {
    return { messageId: await api.send(chatId, render(), buttons, threadId), threadId, fellBack: false }
  } catch (error) {
    if (threadId === null || !isTopicGone(error)) throw error
    const messageId = await api.send(chatId, render(topicGoneNote(threadId)), buttons, null)
    return { messageId, threadId: null, fellBack: true }
  }
}

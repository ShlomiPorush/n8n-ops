import vm from "node:vm"
import type { TelegramRoute } from "../lib/settings.ts"
import { html, type InlineButton, isTopicGone, type Telegram, type TelegramHtml } from "./telegram.ts"

export type AlertSubject = { instanceId?: string; workflowName?: string; tags?: string[] }

export const instanceSubject = (instanceId: string | null): AlertSubject => (instanceId ? { instanceId } : {})

const PATTERN_MS = 20
const sandbox = vm.createContext(Object.create(null))
const matcher = new vm.Script("new RegExp(pattern, 'iu').test(subject)")

const slowPatterns = new Set<string>()

const timedOut = (error: unknown) => (error as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT"

function patternMatches(pattern: string, subject: string, onSlow: (pattern: string) => void) {
  if (slowPatterns.has(pattern)) return false
  sandbox.pattern = pattern
  sandbox.subject = subject.slice(0, 1000)
  for (let attempt = 1; ; attempt++) {
    try {
      return matcher.runInContext(sandbox, { timeout: PATTERN_MS }) === true
    } catch (error) {
      if (!timedOut(error)) return false
      if (attempt === 2) {
        slowPatterns.add(pattern)
        onSlow(pattern)
        return false
      }
    }
  }
}

const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0

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

export function resolveThread(
  config: { routes: TelegramRoute[]; defaultThreadId: number | null },
  subject: AlertSubject,
  onSlow?: (pattern: string) => void,
): number | null {
  for (const route of config.routes) if (routeMatches(route, subject, onSlow)) return route.threadId
  return config.defaultThreadId
}

export const topicGoneNote = (threadId: number) =>
  html`<i>Topic ${threadId} was not found, so this went to General.</i>`

export type Sent = { messageId: number; threadId: number | null; fellBack: boolean }

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

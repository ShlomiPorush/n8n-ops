import { type DateWriting, formatDuration, formatStamp, formatUsed, messageWriting, usedMinutes } from "@n8n-ops/shared"
import { and, eq, isNotNull, isNull, ne, type SQL } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { type AccessDropReason, type AccessStatus, accessRequests, apiTokens } from "../db/schema.ts"
import {
  AccessError,
  type AccessInstanceRow,
  approveAccess,
  type DraftChange,
  denyAccess,
  differsFromAsked,
  editDraft,
  instancesOf,
  nameIn,
} from "./access.ts"
import { availableChannels, channelsFor, dueChannels } from "./access-channels.ts"
import { sendRouted, topicGoneNote } from "./alert-routing.ts"
import { type CallbackUpdate, telegramClient } from "./alerts.ts"
import {
  bullets,
  button,
  type Email,
  formatDate,
  kv,
  mono,
  panel,
  panelText,
  paragraph,
  render,
  type Safe,
} from "./email-layout.ts"
import { directionMark, readsRightToLeft } from "../lib/text-direction.ts"
import { sendEmail } from "./reports.ts"
import { clip, html, type InlineButton, TelegramHtml, telegramPlainText } from "./telegram.ts"

/**
 * Tells approvers about new access requests: a Telegram message with Approve, Deny and Edit buttons, and an email with
 * a link to the request in n8n-ops, on the channels the agent chose or else the default ones (access-channels.ts).
 * Failed sends are retried. In Telegram an approver may leave out instances and change the minutes before approving
 * (the draft); the request page can change everything. Once a request is decided or expires, and again when approved
 * access ends, its Telegram message is edited to say so, without buttons.
 */

/** One instance of a request as a message shows it: the draft while pending, what was granted once approved. */
export type InstanceInfo = {
  position: number
  name: string
  /** The instance was deleted since; its name is the one it had. */
  deleted?: boolean
  /** False for an instance an approver added. */
  requested?: boolean
  scopes: string[]
  workflowIds: string[]
  /** Names by workflow ID, stored with the request; a workflow without one is shown by its ID. */
  workflowNames?: Record<string, string>
  included?: boolean
  droppedReason?: AccessDropReason | null
  droppedScopes?: string[]
}

export type RequestInfo = {
  id: string
  token: string
  reason: string
  /** The draft, or the minutes granted. */
  minutes: number
  /** What the agent asked for; the same as `minutes` when nobody changed it. */
  requestedMinutes?: number
  decideBy: Date
  revision?: number
  instances: InstanceInfo[]
  /** Whether an approver changed what the agent asked for. */
  changed?: boolean
}

const isIncluded = (i: InstanceInfo) => i.included !== false && !i.droppedReason

/** Control characters (line breaks among them), line and paragraph separators, and direction marks and overrides. */
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}؜‎‏‪-‮⁦-⁩]/gu

/**
 * What an agent wrote (its name, its reason, what it says it did), on one line: every line break, control character
 * or direction mark, and every run of spaces, becomes one space. Messages show it set apart from their own lines.
 */
export const oneLine = (text: string) => text.replace(BREAKS, " ").replace(/\s+/g, " ").trim()

/**
 * What an agent wrote, cleaned by `oneLine`, as a Telegram line of its own in italics, after `lead` when given.
 * Telegram takes a line's direction from its first letter, so text that reads right to left (Hebrew with English
 * terms in it) starts with a right-to-left mark and reads as a whole from the right, also when it opens with an
 * English word; on the line of a label it would be read left to right and its words shown out of order.
 */
function agentWords(text: string, lead = "") {
  return html`${lead}${directionMark(text)}<i>${text}</i>`
}

/** A workflow name or ID on one line: each line break, control character or direction mark becomes a space. */
const unbroken = (text: string) => text.replace(BREAKS, " ")

/** The requested workflows of an instance, each with its name when the request has one, as messages show them. */
const workflowsOf = (i: InstanceInfo) =>
  i.workflowIds.map((id) => {
    const name = nameIn(i.workflowNames, id)
    return { id: unbroken(id), name: name === undefined ? undefined : unbroken(name) }
  })

/** Whether messages show every workflow of the instances Approve would grant exactly as stored. */
const shownAsStored = (list: InstanceInfo[]) =>
  list.filter(isIncluded).every((i) =>
    i.workflowIds.every((id) => {
      const name = nameIn(i.workflowNames, id)
      return unbroken(id) === id && (name === undefined || unbroken(name) === name)
    }),
  )

/** Width of a quoted line of the email's text part, in characters, after its "> ". */
const QUOTE_WIDTH = 60

/**
 * Text from outside the request's own facts, for the email's text part: lines of at most QUOTE_WIDTH characters,
 * broken at a space where one is near, each starting with "> ".
 */
function quoted(text: string) {
  const lines: string[] = []
  let rest = [...text]
  while (rest.length > QUOTE_WIDTH) {
    const space = rest.lastIndexOf(" ", QUOTE_WIDTH)
    const cut = space > 0 ? space : QUOTE_WIDTH
    lines.push(rest.slice(0, cut).join(""))
    rest = rest.slice(space > 0 ? cut + 1 : cut)
  }
  lines.push(rest.join(""))
  return lines.map((line) => `> ${line}`)
}

/**
 * A workflow as email text: its name, or its ID when the name is not known, within 60 characters. Word (Outlook for
 * Windows) cannot break a word, so a longer name without spaces would widen the email.
 */
const workflowText = ({ id, name }: { id: string; name?: string }) => clip(name ?? id, 60)

/** How a request ended up: decided, then perhaps ended, with what the agent said and how many calls it made. */
type Outcome = {
  status: AccessStatus
  decidedAt: Date | null
  decidedBy: string | null
  decidedVia: string | null
  expiresAt: Date | null
  endedAt: Date | null
  minutes: number
  summary: string | null
  callCount: number
  refusedCount: number
  /** Approved after an approver changed the request. */
  changed?: boolean
}

/** The longest summary a Telegram message shows; the request page shows all of it. */
const TELEGRAM_SUMMARY_MAX = 500
/**
 * What a message may take, in characters as Telegram counts them, below its limit of 4096: room is left for the note
 * that the access requests topic was gone.
 */
const TELEGRAM_BUDGET = 3900

const channels: Record<string, string> = { telegram: "Telegram", web: "n8n-ops", email: "the email link" }

/** Who decided, as people know them: a Telegram user without the "telegram:" mark, and where they decided. */
function decider(r: Outcome) {
  const who = (r.decidedBy ?? "someone").replace(/^telegram:/, "")
  const channel = r.decidedVia ? channels[r.decidedVia] : undefined
  return clip(channel ? `${who} via ${channel}` : who, 200)
}

/** How many calls the key made, and how many of them n8n-ops refused. */
const callsLine = (calls: number, refused: number) =>
  html`${calls ? `${calls} ${calls === 1 ? "call" : "calls"}` : "No calls"} through n8n-ops${refused ? `, ${refused} refused` : ""}`

/**
 * What a decided or ended request's message shows: an icon for its first line, so the outcome is clear at a glance,
 * and lines under the request saying who decided where, and then how the access ended, how long it was used and
 * what was done. Times are the date and time without the zone; the zone is the one of Settings → General.
 */
export function accessOutcome(r: Outcome, dates: DateWriting): { icon: string; lines: TelegramHtml[] } {
  const stamp = (when: Date) => formatStamp(when, dates, { zone: false })
  const at = (when: Date | null) => (when ? ` at ${stamp(when)}` : "")
  if (r.status === "pending") return { icon: "🔐", lines: [] }
  if (!r.decidedAt) {
    if (r.status === "expired") return { icon: "⌛", lines: [html`⌛ <b>Expired</b> without a decision`] }
    if (r.status === "released") return { icon: "↩️", lines: [html`↩️ <b>Withdrawn</b> by the agent${at(r.endedAt)}`] }
    return { icon: "⛔", lines: [html`⛔ <b>Revoked</b> before a decision${at(r.endedAt)}`] }
  }
  if (r.status === "denied") return { icon: "❌", lines: [html`❌ <b>Denied</b> by ${decider(r)}`] }
  const lines = [html`✅ <b>Approved</b> by ${decider(r)}${r.changed ? ", with changes" : ""}`]
  if (r.status === "approved") {
    lines.push(html`Access until ${r.expiresAt ? stamp(r.expiresAt) : "?"}`)
    return { icon: "✅", lines }
  }
  if (r.status === "released") lines.push(html`⏹ <b>Released</b> by the agent${at(r.endedAt)}`)
  else if (r.status === "expired") lines.push(html`⌛ <b>Access ended</b>${at(r.endedAt)}`)
  else lines.push(html`⛔ <b>Revoked</b>${at(r.endedAt)}`)
  const used = usedMinutes(r)
  if (used !== null) lines.push(html`${formatUsed(used, r.minutes)}`)
  lines.push(html``)
  if (r.summary) lines.push(html`What was done:`, agentWords(clip(oneLine(r.summary), TELEGRAM_SUMMARY_MAX)))
  lines.push(callsLine(r.callCount, r.refusedCount))
  return { icon: "✅", lines }
}

/**
 * A list within about `max` characters, so the message stays under Telegram's limit; the rest is counted. Without
 * `max`, every item in full.
 */
function listWithin(items: string[], max?: number) {
  if (max === undefined) return { shown: items, rest: 0 }
  const shown: string[] = []
  let length = 0
  for (const item of items) {
    const text = clip(item, 100)
    if (shown.length && length + 2 + text.length > max) break
    shown.push(text)
    length += (shown.length > 1 ? 2 : 0) + text.length
  }
  return { shown, rest: items.length - shown.length }
}

/**
 * The workflows of an instance by name, one line each when there are several; a workflow whose name is not known is
 * shown by its ID, in code font. Within about `max` characters, the rest counted; without `max`, all in full.
 */
function workflowLines(i: InstanceInfo, max?: number): TelegramHtml[] {
  if (!i.workflowIds.length) return [html`Workflows: the whole instance`]
  const named = workflowsOf(i)
  const { shown, rest } = listWithin(
    named.map((w) => w.name ?? w.id),
    max,
  )
  const item = (text: string, n: number) => (named[n]?.name === undefined ? html`<code>${text}</code>` : html`${text}`)
  if (named.length === 1) return [html`Workflow: ${item(shown[0] ?? "", 0)}`]
  return [
    html`Workflows:`,
    ...shown.map((text, n) => html`• ${item(text, n)}`),
    ...(rest ? [html`• and ${rest} more`] : []),
  ]
}

function scopesLine(i: InstanceInfo, max?: number) {
  const scopes = listWithin(i.scopes, max)
  return html`Scopes: <code>${scopes.shown.join(", ")}</code>${scopes.rest ? ` and ${scopes.rest} more` : ""}`
}

const dropText: Record<AccessDropReason, string> = {
  closed: "closed to agents",
  deleted: "the instance was deleted",
  no_scopes: "allows none of these scopes any more",
}

/**
 * The first line of an instance: its name (in full, or within 100 characters), and whether it is left out, added,
 * or deleted.
 */
function instanceTitle(i: InstanceInfo, full = false) {
  const name = full ? i.name : clip(i.name, 100)
  if (i.droppedReason) return html`⬜ <b>${name}</b> · left out: ${dropText[i.droppedReason]}`
  if (i.included === false) return html`⬜ <s>${name}</s> · left out`
  const marks = [...(i.requested === false ? ["added"] : []), ...(i.deleted ? ["deleted"] : [])]
  return html`<b>${name}</b>${marks.length ? ` · ${marks.join(", ")}` : ""}`
}

/**
 * One instance with everything: its scopes and workflows, within a length each, or with `full` (for an instance that
 * Approve would grant) every one of them in full.
 */
function instanceBlock(i: InstanceInfo, full = false): TelegramHtml[] {
  const all = full && isIncluded(i)
  const out = all
    ? [instanceTitle(i, true), scopesLine(i), ...workflowLines(i)]
    : [instanceTitle(i), scopesLine(i, 300), ...workflowLines(i, 400)]
  if (i.droppedScopes?.length)
    out.push(html`Left out, no longer allowed: <code>${listWithin(i.droppedScopes, 200).shown.join(", ")}</code>`)
  return out
}

/** One instance on one line, when the message has no room for the details. */
function instanceLine(i: InstanceInfo): TelegramHtml {
  const workflows = i.workflowIds.length
    ? `${i.workflowIds.length} ${i.workflowIds.length === 1 ? "workflow" : "workflows"}`
    : "the whole instance"
  return html`${instanceTitle(i)}: ${i.scopes.length} ${i.scopes.length === 1 ? "scope" : "scopes"}, ${workflows}`
}

/** The instances a request names, for its first line: "name", or "name +N". */
export function instancesLabel(list: { name: string; requested?: boolean }[]) {
  const asked = list.filter((i) => i.requested !== false)
  const first = clip((asked[0] ?? list[0])?.name ?? "?", 200)
  return asked.length > 1 ? `${first} +${asked.length - 1}` : first
}

/** "For 30 min", and what was asked for when an approver changed it. */
function forLine(r: RequestInfo) {
  const asked =
    r.requestedMinutes !== undefined && r.requestedMinutes !== r.minutes
      ? ` (asked for ${formatDuration(r.requestedMinutes)})`
      : ""
  return html`For <b>${formatDuration(r.minutes)}</b>${asked}`
}

/** The text of a request message, without its buttons. */
export function renderAccessTelegram(
  r: RequestInfo,
  dates: DateWriting,
  outcome?: { icon: string; lines: TelegramHtml[] },
): TelegramHtml {
  return telegramRequest(r, dates, outcome).text
}

/**
 * Whether these instances' names, scopes and workflows could fit in one message in full: false when their length
 * alone, at two UTF-16 units a character at most, is past the budget, so a message is never drawn in full to find
 * out.
 */
function mayFit(list: InstanceInfo[]) {
  let length = 0
  for (const i of list) {
    length += i.name.length + i.scopes.reduce((sum, s) => sum + s.length, 0)
    for (const w of workflowsOf(i)) length += (w.name ?? w.id).length
    if (length / 2 > TELEGRAM_BUDGET) return false
  }
  return true
}

/** What a waiting request's message says when it cannot name everything Approve would grant. */
const TOO_LONG = "Too long to approve in Telegram. Open the request in n8n-ops to approve it."
/** What it says when a workflow name or ID could not be shown exactly as it is stored. */
const UNSHOWN =
  "A workflow name or ID here has a line break or control character. Open the request in n8n-ops to approve it."

/**
 * The request message, and whether it names in full every instance, scope and workflow that approving it as it
 * stands would grant (`complete`); only then does its keyboard offer Approve. With one instance as asked, its scopes
 * and workflows follow the reason; with several (or one left out), each instance has its own block. When everything
 * does not fit in full, the lists are cut to a length each and the rest counted; when the blocks still do not fit,
 * each instance takes one line, and then only as many lines as fit, with the rest counted. The request page has
 * every detail. The agent's name follows "Agent" on a line of its own, and its reason is the next line, in italics
 * after a speech balloon, so neither reads as one of the message's own lines and the reason keeps its own direction
 * (`agentWords`); a workflow name or ID that had to be put on one line withholds Approve.
 */
export function telegramRequest(
  r: RequestInfo,
  dates: DateWriting,
  outcome?: { icon: string; lines: TelegramHtml[] },
): { text: TelegramHtml; complete: boolean } {
  const size = (parts: TelegramHtml[]) => [...telegramPlainText(TelegramHtml.join(parts))].length
  const fits = (parts: TelegramHtml[]) => size(parts) <= TELEGRAM_BUDGET
  const head = [
    html`${outcome?.icon ?? "🔐"} <b>Access request</b> · ${instancesLabel(r.instances)}`,
    html`Agent <b>${clip(oneLine(r.token), 200)}</b>:`,
    agentWords(clip(oneLine(r.reason), 500), "💬 "),
    html``,
  ]
  const exact = shownAsStored(r.instances)
  const tooLong = exact ? TOO_LONG : UNSHOWN
  const tail = [
    forLine(r),
    // Only while it waits for a decision; once decided, the outcome says what follows.
    ...(outcome ? [] : [html`Request expires at ${formatStamp(r.decideBy, dates, { zone: false })}`]),
    ...(outcome?.lines.length ? [html``, ...outcome.lines] : []),
  ]
  // Only a waiting request is approved from its message.
  const cut = outcome ? [] : [html`${tooLong}`, html``]
  const only = r.instances[0]
  if (r.instances.length === 1 && only && isIncluded(only) && only.requested !== false && !only.droppedScopes?.length) {
    // The first line is the only place this layout names the instance.
    if (exact && instancesLabel(r.instances) === only.name && mayFit([only])) {
      const full = [...head, scopesLine(only), ...workflowLines(only), ...tail]
      if (fits(full)) return { text: TelegramHtml.join(full), complete: true }
    }
    const lists = [scopesLine(only, 600), ...workflowLines(only, 1200)]
    return {
      text: TelegramHtml.join([...head, ...lists, ...(cut.length ? [html``, ...cut] : []), ...tail]),
      complete: false,
    }
  }

  const blocks = (full: boolean) => r.instances.flatMap((i, n) => [...(n ? [html``] : []), ...instanceBlock(i, full)])
  if (exact && mayFit(r.instances.filter(isIncluded))) {
    const full = [...head, ...blocks(true), html``, ...tail]
    if (fits(full)) return { text: TelegramHtml.join(full), complete: true }
  }
  const within = [...head, ...blocks(false), html``, ...cut, ...tail]
  if (fits(within)) return { text: TelegramHtml.join(within), complete: false }
  return {
    text: compactLines(r, head, tail, outcome ? html`Full details in n8n-ops.` : html`${tooLong}`),
    complete: false,
  }
}

/** Each instance on one line, and only as many lines as fit, with the rest counted. */
function compactLines(r: RequestInfo, head: TelegramHtml[], tail: TelegramHtml[], more: TelegramHtml) {
  const size = (parts: TelegramHtml[]) => [...telegramPlainText(TelegramHtml.join(parts))].length
  const lines: TelegramHtml[] = []
  for (const [n, i] of r.instances.entries()) {
    const rest = r.instances.length - n
    const restLine = html`and ${rest} more ${rest === 1 ? "instance" : "instances"}`
    if (size([...head, ...lines, instanceLine(i), restLine, more, html``, ...tail]) > TELEGRAM_BUDGET) {
      lines.push(restLine)
      break
    }
    lines.push(instanceLine(i))
  }
  return TelegramHtml.join([...head, ...lines, more, html``, ...tail])
}

/** The email lines of one instance's workflows. */
function emailWorkflows(i: InstanceInfo) {
  const named = workflowsOf(i).map((w) => ({ ...w, shown: workflowText(w) }))
  const value = (w: (typeof named)[number]) => (w.name === undefined ? mono(w.shown) : w.shown)
  return { named, value }
}

/**
 * The text-part lines of one instance's workflows, a single one on the label's line unless `list`; one known only by
 * its ID is quoted.
 */
function textWorkflows(named: ReturnType<typeof emailWorkflows>["named"], list = false) {
  const [first] = named
  if (!first) return ["Workflows: the whole instance"]
  if (named.length === 1 && !list)
    return first.name === undefined ? ["Workflow, by its ID:", ...quoted(first.shown)] : [`Workflow: ${first.shown}`]
  return [
    "Workflows:",
    ...named.flatMap((w) => (w.name === undefined ? ["• by its ID:", ...quoted(w.shown)] : [`• ${w.shown}`])),
  ]
}

/**
 * The email for a waiting request: who asks, for how long, for what, and one button to decide in n8n-ops.
 * Workflows are named as in Telegram: without their IDs, one line each when there are several, and an ID in code
 * font only when the name is not known. Times follow Settings → General, without the zone (EM-6). Several
 * instances each get a panel of their own. In the text part, what the agent wrote (its name and reason) and a
 * workflow known only by its ID are quoted, so none of it reads as one of the email's own lines.
 */
export function renderAccessEmail(
  r: RequestInfo,
  link: string | null,
  dates: DateWriting = messageWriting(undefined),
): Email {
  const expires = formatDate(r.decideBy, dates, true)
  const length = formatDuration(r.minutes)
  const agent = oneLine(r.token)
  const list = r.instances.filter(isIncluded)
  const target = list.length === 1 ? (list[0]?.name ?? "?") : `${list.length} instances`
  const decide = link
    ? `Approve, change or deny: ${link} (sign in with two-factor).`
    : "Approve, change or deny it on the Agent Access page in n8n-ops."
  const action = link
    ? button("Approve, change or deny", link)
    : paragraph("Approve, change or deny it on the Agent Access page in n8n-ops.", true)

  let text: string[]
  let blocks: Safe[]
  const only = list[0]
  if (list.length === 1 && only) {
    const { named, value } = emailWorkflows(only)
    const several = named.length > 1
    const workflowRow: [string, Safe | string] = named[0]
      ? ["Workflow", value(named[0])]
      : ["Workflows", "The whole instance"]
    text = [`Scopes: ${only.scopes.join(", ")}`, ...textWorkflows(named)]
    blocks = [
      panel("What it asks for", [
        kv([
          ["Agent", agent],
          ["Instance", only.name],
          ["Scopes", mono(only.scopes.join(", "))],
          ...(several ? [] : [workflowRow]),
          ["For", length],
          ["Request expires", expires],
        ]),
      ]),
      ...(several ? [panel("Workflows", [bullets(named.map(value))], { count: named.length })] : []),
    ]
  } else {
    text = list.flatMap((i) => {
      const { named } = emailWorkflows(i)
      return ["", i.name, `Scopes: ${i.scopes.join(", ")}`, ...textWorkflows(named, true)]
    })
    blocks = [
      panel("What it asks for", [
        kv([
          ["Agent", agent],
          ["Instances", String(list.length)],
          ["For", length],
          ["Request expires", expires],
        ]),
      ]),
      ...list.map((i) => {
        const { named, value } = emailWorkflows(i)
        return panel(clip(i.name, 60), [
          kv([
            ["Scopes", mono(i.scopes.join(", "))],
            ...(named.length ? [] : [["Workflows", "The whole instance"] as [string, string]]),
          ]),
          ...(named.length ? [bullets(named.map(value))] : []),
        ])
      }),
    ]
  }

  const lines = [
    `An agent asks for ${length} of access to ${target}.`,
    "",
    "Agent:",
    ...quoted(agent),
    "Reason:",
    ...quoted(oneLine(r.reason)),
    ...text,
    ...(list.length === 1 ? [] : [""]),
    `For: ${length}`,
    `Request expires at ${expires}.`,
    "",
    decide,
  ]
  const body = render({
    title: `${agent} asks for ${length} of access to ${target}`,
    topic: "Access request",
    tone: "warn",
    intro: `Nothing is granted until someone approves it. Without a decision, the request expires at ${expires}.`,
    dates,
    blocks: [
      panel("Why", [panelText(r.reason, readsRightToLeft(r.reason) ? "rtl" : "ltr")]),
      ...blocks,
      action,
      ...(link ? [paragraph("You sign in with two-factor before deciding.", true)] : []),
    ],
    footer: "You get this because Email requests is on in Settings → Agent Access.",
  })
  return {
    subject: `n8n-ops: ${agent} asks for ${length} of access to ${target}`,
    text: lines.join("\n"),
    html: body,
  }
}

async function publicLink(ctx: Ctx, id: string) {
  const { publicUrl } = await ctx.settings.get("general")
  return publicUrl ? `${publicUrl.replace(/\/+$/, "")}/access/${id}` : null
}

/** Telegram accepts only public https links on buttons. */
const openButton = (link: string | null): InlineButton[][] =>
  link?.startsWith("https://") ? [[{ text: "Open in n8n-ops", url: link }]] : []

/**
 * The keyboard of a waiting request: decide, or switch to editing. Approve is offered only when the message names
 * everything it grants (`complete`, from `telegramRequest`); it names the revision shown, and ends in `:g`, which
 * only such a message drawn with the agent's words set apart carries.
 */
export function decideButtons(
  r: Pick<RequestInfo, "id" | "revision">,
  link: string | null,
  complete: boolean,
): InlineButton[][] {
  const rev = r.revision ?? 0
  return [
    [
      ...(complete ? [{ text: "✅ Approve", callback_data: `xa:${r.id}:${rev}:g` }] : []),
      { text: "❌ Deny", callback_data: `xd:${r.id}` },
    ],
    [{ text: "✏️ Edit", callback_data: `xe:${r.id}` }],
    ...openButton(link),
  ]
}

/** The most instance switches the edit keyboard shows; the request page edits the rest. */
const TOGGLES_SHOWN = 20
const PRESETS = [15, 30, 60, 120, 240, 480]

/** The minutes an approver can pick in Telegram: presets, what was asked, the draft, and the longest allowed. */
export function presetMinutes(r: Pick<RequestInfo, "minutes" | "requestedMinutes">, maxMinutes: number) {
  const all = new Set([...PRESETS, r.requestedMinutes ?? r.minutes, r.minutes, maxMinutes])
  return [...all].filter((m) => m >= 1 && m <= maxMinutes).sort((a, b) => a - b)
}

/**
 * The keyboard while editing: one switch per instance the agent asked for (it sets the state shown on the other
 * side, never flips), the minutes, and Done. Every button names the revision shown, so a press on an old view is
 * refused instead of changing something else.
 */
export function editButtons(r: RequestInfo, maxMinutes: number, link: string | null): InlineButton[][] {
  const rev = r.revision ?? 0
  const toggles = r.instances
    .filter((i) => i.requested !== false && !i.deleted)
    .slice(0, TOGGLES_SHOWN)
    .map((i) => {
      const on = i.included !== false
      return [
        {
          text: `${on ? "✅" : "⬜"} ${clip(i.name, 40)}`,
          callback_data: `xt:${r.id}:${i.position}:${on ? 0 : 1}:${rev}`,
        },
      ]
    })
  const minutes = presetMinutes(r, maxMinutes).map((m) => ({
    text: m === r.minutes ? `• ${formatDuration(m)}` : formatDuration(m),
    callback_data: `xm:${r.id}:${m}:${rev}`,
  }))
  const rows: InlineButton[][] = []
  for (let n = 0; n < minutes.length; n += 4) rows.push(minutes.slice(n, n + 4))
  return [...toggles, ...rows, [{ text: "✓ Done", callback_data: `xv:${r.id}` }], ...openButton(link)]
}

/** An instance row as a message shows it. */
const instanceInfo = (c: AccessInstanceRow): InstanceInfo => ({
  position: c.position,
  name: c.instanceName,
  deleted: c.instanceId === null,
  requested: c.requestedScopes !== null,
  scopes: c.scopes,
  workflowIds: c.workflowIds,
  workflowNames: c.workflowNames,
  included: c.included,
  droppedReason: c.droppedReason,
  droppedScopes: c.droppedScopes,
})

async function requestsWith(ctx: Ctx, where: SQL | undefined) {
  const rows = await ctx.db
    .select({ r: accessRequests, token: apiTokens.name })
    .from(accessRequests)
    .innerJoin(apiTokens, eq(accessRequests.tokenId, apiTokens.id))
    .where(where)
  const children = await instancesOf(
    ctx.db,
    rows.map((x) => x.r.id),
  )
  return rows.map(({ r, token }) => {
    const list = children.get(r.id) ?? []
    const info: RequestInfo = {
      id: r.id,
      token,
      reason: r.reason,
      minutes: r.minutes,
      requestedMinutes: r.requestedMinutes,
      decideBy: r.decideBy,
      revision: r.revision,
      instances: list.map(instanceInfo),
      changed: differsFromAsked(r, list),
    }
    return { r, info }
  })
}

/**
 * Background job: notify approvers of new requests, and close the Telegram messages of finished ones. Each request
 * goes to the channels `channelsFor` gives it on this run; a channel that failed waits the retry time on its own.
 */
export async function notifyAccess(ctx: Ctx) {
  const { defaultNotify } = await ctx.settings.get("access")
  const { retryMin } = await ctx.settings.get("alerts")
  const dates = messageWriting(await ctx.settings.get("general"))
  const available = await availableChannels(ctx)
  const tg = available.includes("telegram") ? await telegramClient(ctx) : null
  const now = Date.now()

  const waiting = await requestsWith(ctx, eq(accessRequests.status, "pending"))
  for (const { r, info } of waiting) {
    if (r.decideBy.getTime() < now) continue
    const sent = { telegram: r.telegramMessageId !== null, email: r.emailSentAt !== null }
    const due = dueChannels(
      channelsFor(r.notifyChoice, defaultNotify, available),
      sent,
      r.notifyFailed,
      now,
      retryMin * 60_000,
    )
    if (!due.length) continue
    const link = await publicLink(ctx, r.id)
    const errors: string[] = []
    const failed = { ...r.notifyFailed }
    const patch: Partial<typeof accessRequests.$inferInsert> = { notifyAttemptAt: new Date() }
    if (due.includes("telegram") && tg) {
      try {
        const { text, complete } = telegramRequest(info, dates)
        const sent = await sendRouted(
          tg.api,
          tg.chatId,
          tg.accessThreadId,
          (note) => (note ? TelegramHtml.join([note, text]) : text),
          decideButtons(info, link, complete),
        )
        if (sent.fellBack) ctx.log.warn("Telegram topic not found; the access request went to General")
        patch.telegramMessageId = sent.messageId
        patch.telegramMissingTopic = sent.fellBack ? tg.accessThreadId : null
        delete failed.telegram
      } catch (e) {
        errors.push(`Telegram: ${(e as Error).message}`)
        failed.telegram = new Date().toISOString()
      }
    }
    if (due.includes("email")) {
      try {
        await sendEmail(ctx, renderAccessEmail(info, link, dates))
        patch.emailSentAt = new Date()
        delete failed.email
      } catch (e) {
        errors.push(`Email: ${(e as Error).message}`)
        failed.email = new Date().toISOString()
      }
    }
    patch.notifyFailed = failed
    patch.notifyError = errors.length ? errors.join("; ") : null
    await ctx.db.update(accessRequests).set(patch).where(eq(accessRequests.id, r.id))
    if (errors.length) ctx.log.warn("access request notification failed", { requestId: r.id, errors })
  }
  await closeTelegramMessages(ctx)
}

/**
 * Edits of request messages run one at a time (the scheduler and button presses both make them), each reading the
 * request when its turn comes, so an older edit never lands after a newer one, and a waiting request's message is
 * never drawn with buttons after its outcome was.
 */
let editing: Promise<void> = Promise.resolve()
function inTurn(work: () => Promise<void>) {
  editing = editing.catch(() => undefined).then(work)
  return editing
}

/**
 * Edits the Telegram message of every decided or ended request to its outcome, without buttons: once when it is
 * decided, and again when approved access ends (released, expired or revoked).
 */
export function closeTelegramMessages(ctx: Ctx) {
  return inTurn(() => closeOutdated(ctx))
}

/** Draws a waiting request's message again, with its decision keyboard or its edit keyboard. */
function redrawWaiting(ctx: Ctx, id: string, mode: "decide" | "edit") {
  return inTurn(async () => {
    const tg = await telegramClient(ctx)
    if (!tg) return
    const [found] = await requestsWith(ctx, eq(accessRequests.id, id))
    if (found?.r.status !== "pending" || found.r.telegramMessageId === null) return
    const { r, info } = found
    const dates = messageWriting(await ctx.settings.get("general"))
    const link = await publicLink(ctx, id)
    const { maxMinutes } = await ctx.settings.get("access")
    const { text, complete } = telegramRequest(info, dates)
    const note = r.telegramMissingTopic ? topicGoneNote(r.telegramMissingTopic) : undefined
    const keyboard = mode === "edit" ? editButtons(info, maxMinutes, link) : decideButtons(info, link, complete)
    try {
      await tg.api.edit(tg.chatId, r.telegramMessageId ?? 0, note ? TelegramHtml.join([note, text]) : text, keyboard)
    } catch (e) {
      ctx.log.warn("could not update the access request message", { requestId: id, error: (e as Error).message })
    }
  })
}

async function closeOutdated(ctx: Ctx) {
  const tg = await telegramClient(ctx)
  if (!tg) return
  const dates = messageWriting(await ctx.settings.get("general"))
  // Every change of status clears telegramClosedAt in the same update (access.ts), so these are the messages
  // that do not show their request's status yet.
  const outdated = await requestsWith(
    ctx,
    and(
      isNotNull(accessRequests.telegramMessageId),
      ne(accessRequests.status, "pending"),
      isNull(accessRequests.telegramClosedAt),
    ),
  )
  for (const { r, info } of outdated) {
    try {
      const text = renderAccessTelegram(info, dates, accessOutcome({ ...r, changed: info.changed }, dates))
      const note = r.telegramMissingTopic ? topicGoneNote(r.telegramMissingTopic) : undefined
      await tg.api.edit(tg.chatId, r.telegramMessageId ?? 0, note ? TelegramHtml.join([note, text]) : text)
      // Marked as shown only if the status and the counts are still the ones shown; if any changed meanwhile, the
      // next run edits again. A call logged now holds the row, and this update then checks the counts it left.
      await ctx.db
        .update(accessRequests)
        .set({ telegramClosedAt: new Date() })
        .where(
          and(
            eq(accessRequests.id, r.id),
            eq(accessRequests.status, r.status),
            eq(accessRequests.callCount, r.callCount),
            eq(accessRequests.refusedCount, r.refusedCount),
          ),
        )
    } catch (e) {
      ctx.log.warn("could not update the access request message", { requestId: r.id, error: (e as Error).message })
    }
  }
}

/** Whether this Telegram user may approve: listed as an approver, or the user of the private chat when none are. */
export function isApprover(
  approvers: string[],
  chatId: string,
  from: { id: number; username?: string } | undefined,
): boolean {
  if (!from) return false
  const id = String(from.id)
  const username = from.username ? `@${from.username}`.toLowerCase() : null
  const listed = approvers.map((a) => a.trim()).filter(Boolean)
  if (listed.length) return listed.some((a) => a === id || (username !== null && a.toLowerCase() === username))
  return id === chatId
}

/** A button press on a request message, as its callback data says it. */
export type AccessPress =
  /** `full`: pressed on a message that named everything Approve grants. */
  | { action: "approve"; id: string; revision: number; full: boolean }
  | { action: "deny"; id: string }
  | { action: "edit" | "done"; id: string }
  | { action: "change"; id: string; revision: number; change: DraftChange }

const UUID = /^[0-9a-f-]{36}$/i
const NUMBER = /^\d{1,9}$/

/**
 * Reads callback data: `xa:<id>:<revision>:g` (and, from messages drawn before the agent's words were set apart,
 * `xa:<id>:<revision>:f`, and from those sent before Approve required a complete message, `xa:<id>:<revision>` and
 * `xa:<id>`, read as revision 0, all of which approve nothing), `xd:<id>`, `xe:<id>`, `xv:<id>`,
 * `xt:<id>:<position>:<0|1>:<revision>`, `xm:<id>:<minutes>:<revision>`. Anything else is not an access request press.
 */
export function parsePress(data: string | undefined): AccessPress | null {
  const [action, id, a, b, c, ...extra] = (data ?? "").split(":")
  if (!action || !id || !UUID.test(id) || extra.length) return null
  const num = (v: string | undefined) => (v !== undefined && NUMBER.test(v) ? Number(v) : null)
  if (action === "xa") {
    if (c !== undefined || (b !== undefined && b !== "f" && b !== "g")) return null
    const revision = a === undefined ? 0 : num(a)
    return revision === null ? null : { action: "approve", id, revision, full: b === "g" }
  }
  if (a !== undefined && (action === "xd" || action === "xe" || action === "xv")) return null
  if (action === "xd") return { action: "deny", id }
  if (action === "xe") return { action: "edit", id }
  if (action === "xv") return { action: "done", id }
  if (action === "xt" && (b === "0" || b === "1")) {
    const position = num(a)
    const revision = num(c)
    if (position === null || revision === null) return null
    return { action: "change", id, revision, change: { position, included: b === "1" } }
  }
  if (action === "xm" && c === undefined) {
    const minutes = num(a)
    const revision = num(b)
    if (minutes === null || revision === null) return null
    return { action: "change", id, revision, change: { minutes } }
  }
  return null
}

/**
 * Why an Approve press approves nothing, if it does not: it came from a message that did not name everything Approve
 * grants (an Approve without `:g`, drawn before its message set the agent's words apart), or the request at the
 * revision pressed is too long for its message to name everything, or has a workflow name or ID that the message
 * could not show exactly as it is stored. A request no longer waiting, or at another revision, is left to
 * `approveAccess`, which says so. The revision is checked again when the approval is stored.
 */
async function approveRefusal(ctx: Ctx, press: Extract<AccessPress, { action: "approve" }>) {
  const [found] = await requestsWith(ctx, eq(accessRequests.id, press.id))
  if (found?.r.status !== "pending" || found.r.decideBy < new Date() || found.r.revision !== press.revision) return null
  if (!press.full) return "This message was out of date. Look at it again, then decide."
  const dates = messageWriting(await ctx.settings.get("general"))
  if (telegramRequest(found.info, dates).complete) return null
  return shownAsStored(found.info.instances) ? TOO_LONG : UNSHOWN
}

/** A button pressed on a request message. Returns false if the update is not about an access request. */
export async function handleAccessCallback(
  ctx: Ctx,
  tg: NonNullable<Awaited<ReturnType<typeof telegramClient>>>,
  cb: NonNullable<CallbackUpdate["callback_query"]>,
): Promise<boolean> {
  const press = parsePress(cb.data)
  if (!press) return false
  const who = cb.from?.username ? `@${cb.from.username}` : String(cb.from?.id ?? "someone")
  const { telegramApprovers } = await ctx.settings.get("access")
  if (!isApprover(telegramApprovers, tg.chatId, cb.from)) {
    await ctx.audit({
      actor: `telegram:${who}`,
      action: "Access decision refused",
      target: press.id,
      via: "telegram",
      details: { reason: "not an approver", telegramUserId: cb.from?.id ?? null },
    })
    await tg.api.answerCallback(cb.id, "Only approvers set in n8n-ops can decide access requests.")
    return true
  }
  const decider = { by: `telegram:${who}`, via: "telegram" as const }
  if (press.action === "edit" || press.action === "done") {
    await tg.api.answerCallback(cb.id, press.action === "edit" ? "Change the request, then Done" : "Done")
    await redrawWaiting(ctx, press.id, press.action === "edit" ? "edit" : "decide")
    return true
  }
  if (press.action === "change") {
    try {
      await editDraft(ctx, press.id, press.revision, press.change)
      await tg.api.answerCallback(cb.id, "Changed")
    } catch (e) {
      if (!(e instanceof AccessError)) throw e
      await tg.api.answerCallback(cb.id, clip(e.message, 190))
    }
    await redrawWaiting(ctx, press.id, "edit")
    await closeTelegramMessages(ctx)
    return true
  }
  if (press.action === "approve") {
    const refused = await approveRefusal(ctx, press)
    if (refused) {
      await tg.api.answerCallback(cb.id, refused)
      await redrawWaiting(ctx, press.id, "decide")
      return true
    }
  }
  try {
    if (press.action === "approve") await approveAccess(ctx, press.id, decider, { revision: press.revision })
    else await denyAccess(ctx, press.id, decider)
    await tg.api.answerCallback(cb.id, press.action === "approve" ? "Access approved" : "Request denied")
  } catch (e) {
    if (!(e instanceof AccessError)) throw e
    await tg.api.answerCallback(cb.id, clip(e.message, 190))
    // A press on an old view: the message shows the request as it is now.
    if (e.code === "request_changed") await redrawWaiting(ctx, press.id, "decide")
  }
  await closeTelegramMessages(ctx)
  return true
}

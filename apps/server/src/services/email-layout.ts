/*
 * The HTML layout of every email n8n-ops sends, in the v3 design language of the console (EM-1, EM-2).
 *
 * Email clients ignore stylesheets, CSS variables and grid, so the blocks are tables with inline styles. The
 * colours are the light theme of apps/web/src/index.css; a <style> block switches to the dark theme in the
 * clients that honour prefers-color-scheme (Apple Mail, iOS, Outlook for Mac).
 *
 * Outlook for Windows draws email with Word, which ignores padding and margins outside table cells, rounded
 * corners, max-width and font fallbacks. So every gap is cell padding or a spacer row, divider lines are 1px
 * rows, the email is wrapped in a 600px table for Outlook, and a block never relies on margins. Panels,
 * banners and cards stay square there: a VML shape that grows with its content does not push the next block
 * down, so blocks overlap. Only the topic tag, which has a fixed size, gets a rounded VML shape.
 *
 * Every value passed to a block is escaped. Only the output of another block (a Safe string) is inserted as
 * markup, so callers never escape by hand:
 *
 *   render({ title: "2 instances are down", topic: "Health", tone: "fail", blocks: [panel("Instances", table(...))] })
 */

/** Markup produced by this module; inserted without escaping. */
export class Safe {
  constructor(readonly html: string) {}
  toString() {
    return this.html
  }
}

type Text = string | number | Safe | null | undefined
export type Tone = "ok" | "warn" | "fail" | "info" | "muted"

const escapeText = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")

/** Escape for an attribute or a place that takes no markup. */
function attr(value: Text): string {
  if (value instanceof Safe) return value.html
  return escapeText(value === null || value === undefined ? "" : String(value))
}

export const FONT = "Onest, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
export const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

// The light theme of the console.
const BG = "#FFFFFF"
const PANEL = "#F4F6F5"
const INK = "#111814"
const MUTED = "#5E6863"
const LINE = "#E3E7E5"

/** Each tone's colour and its tag or banner tint: the colour at 13 to 15% over white, as color-mix() gives in
 * the console; email clients cannot mix colours. */
const TONES: Record<Tone, [string, string]> = {
  ok: ["#12803F", "#E0F0E6"],
  warn: ["#9A6200", "#F2EAD9"],
  fail: ["#C42B1C", "#F8E0DE"],
  info: ["#1F5FBF", "#E0E9F6"],
  muted: ["#5E6863", "#ECEEED"],
}
const tone = (t?: Tone | null) => TONES[t ?? "muted"] ?? TONES.muted
const CLASS_COLORS: Record<string, string> = {
  "m-ink": INK,
  "m-muted": MUTED,
  ...Object.fromEntries(Object.entries(TONES).map(([t, [c]]) => [`m-${t}`, c])),
}

// Runs of the characters an address is made of. The text can come from outside (workflow names, error
// messages, an agent's reason), so the scan stays linear: one character class, no nested quantifiers;
// whether a run is an address is decided by plain string checks (EM-4).
const ADDRESS_RUN = /[A-Za-z0-9._%+@-]+/g
const DOMAIN_LABEL = /^[A-Za-z0-9-]+$/

function isAddress(text: string): boolean {
  const at = text.indexOf("@")
  if (at <= 0 || text.indexOf("@", at + 1) >= 0) return false
  const labels = text.slice(at + 1).split(".")
  return labels.length >= 2 && labels.every((l) => DOMAIN_LABEL.test(l))
}

/**
 * Escape visible text whose colour class is `cls`. Gmail and Outlook turn every address into a blue link of
 * their own, and Outlook ignores color:inherit, so an address becomes a link of ours in the text colour.
 */
function e(value: Text, cls = "m-ink"): string {
  if (value instanceof Safe) return value.html
  const color = CLASS_COLORS[cls] ?? INK
  return attr(value).replace(ADDRESS_RUN, (run) => {
    const address = run.replace(/\.+$/, "") // the full stop of a sentence is not part of it
    if (!isAddress(address)) return run
    return `<a href="mailto:${address}" class="${cls}" style="color:${color};text-decoration:none;">${address}</a>${run.slice(address.length)}`
  })
}

/** Escape, then keep line breaks. */
function lines(value: Text, cls = "m-ink"): string {
  if (value instanceof Safe) return value.html
  return e(value, cls).replace(/\n/g, "<br>")
}

/** A count with its word, singular or plural, with thousands separators: "1 problem", "1,920 failures". */
export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`

/** A time zone the runtime knows; an unknown one falls back to UTC, like the server. */
function knownZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone })
    return timeZone
  } catch {
    return "UTC"
  }
}

/** Day/month/year in the console's time zone, like the dates in the console's tables (EM-6). */
export function formatDate(when: Date, timeZone: string, time = false): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: knownZone(timeZone),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(when)
      .map((p) => [p.type, p.value]),
  )
  const date = `${parts.day}/${parts.month}/${parts.year}`
  return time ? `${date} ${parts.hour}:${parts.minute}` : date
}

const DARK_CSS = `
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  .m-bg { background-color: #0E1110 !important; }
  .m-panel { background-color: #171B19 !important; }
  .m-ink { color: #F2F5F3 !important; }
  .m-muted { color: #97A29C !important; }
  .m-line { border-color: #262C29 !important; }
  .m-rule { background-color: #262C29 !important; }
  .m-mark { background-color: #F2F5F3 !important; color: #0E1110 !important; }
  .m-ok { color: #3FCF7F !important; } .m-ok-bg { background-color: #1A3325 !important; }
  .m-warn { color: #F0B03F !important; } .m-warn-bg { background-color: #3A2F1A !important; }
  .m-fail { color: #FF6B61 !important; } .m-fail-bg { background-color: #3D2220 !important; }
  .m-info { color: #7DB3FF !important; } .m-info-bg { background-color: #1E2C40 !important; }
  .m-muted-bg { background-color: #232826 !important; }
}
@media (max-width: 620px) {
  .m-wrap { padding: 24px 16px !important; }
  .m-h1 { font-size: 26px !important; }
  .m-stat { padding: 9px 10px !important; }
  .m-stat-v { font-size: 20px !important; }
  .m-cell { padding-left: 10px !important; padding-right: 10px !important; }
}
`

// Word knows only bold and normal, and takes the first font of a list even when it is not installed (then it
// shows Times New Roman).
const MSO_CSS = `<!--[if mso]><style>
v\\:* { behavior: url(#default#VML); display: inline-block; }
body, table, td, th, p, a, span, h1, div { font-family: 'Segoe UI', Arial, sans-serif !important; }
.m-mono { font-family: Consolas, 'Courier New', monospace !important; }
.m-b { font-weight: bold !important; }
</style><![endif]-->`

const TABLE = 'role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"'
const spacer = (px: number) =>
  `<tr><td height="${px}" style="height:${px}px;font-size:1px;line-height:1px;">&nbsp;</td></tr>`

/** A 1px divider row; Word draws cell borders unevenly. */
const rule = (colspan = 1) =>
  `<tr><td class="m-rule" colspan="${colspan}" height="1" style="height:1px;font-size:1px;line-height:1px;mso-line-height-rule:exactly;background-color:${LINE};">&nbsp;</td></tr>`

function tagHtml(text: string, t: Tone, roundedInOutlook: boolean): string {
  const [color, tint] = tone(t)
  const cell =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table;vertical-align:middle;">` +
    `<tr><td class="m-${t} m-${t}-bg m-b" bgcolor="${tint}" style="padding:2px 8px;border-radius:6px;background-color:${tint};color:${color};font-size:12px;font-weight:700;line-height:1.4;white-space:nowrap;">` +
    `${e(text, `m-${t}`)}</td></tr></table>`
  if (!roundedInOutlook) return cell
  // VML inside a table, followed by more VML, can make Word report the table as corrupt: only the topic tag
  // gets this shape.
  const width = text.length * 7 + 18
  return (
    `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" arcsize="30%" fillcolor="${tint}" stroked="f" ` +
    `style="width:${(width * 3) / 4}pt;height:15pt;v-text-anchor:middle;"><v:textbox inset="0,0,0,0">` +
    `<center style="color:${color};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:bold;">` +
    `${attr(text)}</center></v:textbox></v:roundrect><![endif]-->` +
    `<!--[if !mso]><!-->${cell}<!--<![endif]-->`
  )
}

/** A small status label, as in the console. A table cell, so Word keeps its padding. */
export const tag = (text: string, t: Tone = "muted") => new Safe(tagHtml(text, t, false))

export function strong(text: Text, t?: Tone): Safe {
  const color = t ? tone(t)[0] : INK
  const cls = t ? `m-${t}` : "m-ink"
  return new Safe(`<b class="${cls} m-b" style="color:${color};font-weight:650;">${e(text, cls)}</b>`)
}

/**
 * Technical values (IDs, scopes, keys). Long values without spaces may break anywhere instead of widening
 * the email; Word cannot break them at all, so maxLength shortens them in the middle.
 */
export function mono(value: Text, maxLength?: number): Safe {
  let text = value instanceof Safe ? value.html : value === null || value === undefined ? "" : String(value)
  if (maxLength && text.length > maxLength) {
    const keep = maxLength - 1
    const head = Math.floor((keep * 2) / 3)
    text = `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`
  }
  return new Safe(
    `<span class="m-mono" style="font-family:${MONO};font-size:13px;word-break:break-all;">${e(text)}</span>`,
  )
}

/** A link; only http(s) addresses become links, anything else stays text (OT-17). */
export function link(text: Text, url: string | null | undefined): Safe {
  if (!url || !/^https?:\/\//i.test(url)) return new Safe(e(text))
  return new Safe(`<a href="${attr(url)}" class="m-ink" style="color:${INK};text-decoration:underline;">${e(text)}</a>`)
}

/** The one call to action of an email: a dark button that works in Outlook as a padded cell. */
export function button(text: string, url: string | null | undefined): Safe {
  if (!url || !/^https?:\/\//i.test(url)) return new Safe("")
  return new Safe(
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
      `<td class="m-mark" bgcolor="${INK}" style="padding:10px 18px;background-color:${INK};border-radius:8px;">` +
      `<a href="${attr(url)}" class="m-mark m-b" style="display:inline-block;color:${BG};font-size:14px;font-weight:700;text-decoration:none;">${attr(text)}</a>` +
      `</td></tr></table>`,
  )
}

export function paragraph(text: Text, muted = false): Safe {
  const [color, cls] = muted ? [MUTED, "m-muted"] : [INK, "m-ink"]
  return new Safe(
    `<p class="${cls}" style="margin:0;color:${color};font-size:15px;line-height:1.55;">${lines(text, cls)}</p>`,
  )
}

/** A tinted message across the full width, as a console banner. */
export function banner(t: Tone, title: Text, text?: Text): Safe {
  const [color, tint] = tone(t)
  const body = text
    ? `<tr><td class="m-ink" style="padding:3px 16px 0;color:${INK};font-size:14px;line-height:1.5;">${lines(text)}</td></tr>`
    : ""
  return new Safe(
    `<table ${TABLE} class="m-${t}-bg" bgcolor="${tint}" style="background-color:${tint};border-radius:12px;">` +
      spacer(13) +
      `<tr><td class="m-${t} m-b" style="padding:0 16px;color:${color};font-size:14px;font-weight:700;line-height:1.4;">${lines(title, `m-${t}`)}</td></tr>` +
      body +
      spacer(13) +
      `</table>`,
  )
}

/** A key figure: label, value, and optionally a tone and a note under the value. */
export type Stat = { label: string; value: Text; tone?: Tone; note?: string }

/** Key figures in bordered cells, as the console's figures. One table per row, so a short last row keeps the
 * width of the others. */
export function stats(items: Stat[], perRow = 3): Safe {
  const width = Math.floor(100 / perRow)
  const rows: string[] = []
  for (let start = 0; start < items.length; start += perRow) {
    const chunk = items.slice(start, start + perRow)
    const cells: string[] = []
    for (let i = 0; i < perRow; i++) {
      if (i) cells.push('<td width="8" style="width:8px;font-size:1px;line-height:1px;">&nbsp;</td>')
      const item = chunk[i]
      if (!item) {
        cells.push(`<td width="${width}%">&nbsp;</td>`)
        continue
      }
      const color = item.tone ? tone(item.tone)[0] : INK
      const vcls = item.tone ? `m-${item.tone}` : "m-ink"
      const note = item.note
        ? `<br><span class="m-muted" style="color:${MUTED};font-size:12px;line-height:1.4;">${e(item.note, "m-muted")}</span>`
        : ""
      cells.push(
        `<td class="m-stat m-line" width="${width}%" valign="top" style="padding:11px 14px;border:1px solid ${LINE};border-radius:12px;">` +
          `<span class="m-muted" style="color:${MUTED};font-size:12.5px;line-height:1.4;">${e(item.label, "m-muted")}</span><br>` +
          `<b class="${vcls} m-stat-v" style="color:${color};font-size:24px;line-height:1.3;font-weight:700;letter-spacing:-0.02em;">${e(item.value, vcls)}</b>${note}</td>`,
      )
    }
    rows.push(`<table ${TABLE}><tr>${cells.join("")}</tr></table>`)
  }
  // Outlook drops the bottom border of cards in the last row of a table, so an empty 1px row closes it.
  return new Safe(
    `<table ${TABLE}>${rows.map((row, i) => `<tr><td style="padding:${i ? "8px" : "0"} 0 0;">${row}</td></tr>`).join("")}${spacer(1)}</table>`,
  )
}

/** Label on the left, value on the right, a line between rows. */
export function kv(rows: [label: string, value: Text, tone?: Tone][]): Safe {
  const out = rows.map(([label, value, t]) => {
    const color = t ? tone(t)[0] : INK
    const vcls = t ? `m-${t}` : "m-ink"
    // Markup such as a tag must not sit inside <b>: Word then reports the table as corrupt.
    const shown = value instanceof Safe ? value.html : `<b style="font-weight:650;">${lines(value, vcls)}</b>`
    return (
      rule(2) +
      `<tr><td class="m-muted m-cell" valign="top" style="padding:9px 16px;color:${MUTED};font-size:14px;">${e(label, "m-muted")}</td>` +
      `<td class="${vcls} m-cell" valign="top" align="right" style="padding:9px 16px;color:${color};font-size:14px;text-align:right;overflow-wrap:break-word;">${shown}</td></tr>`
    )
  })
  return new Safe(`<table ${TABLE}>${out.join("")}</table>`)
}

/** A data table inside a panel. Columns are names, or [name, "right"] for numbers. */
export function table(
  columns: (string | [string, "left" | "right"])[],
  rows: Text[][],
  { empty = "Nothing to show", head = true }: { empty?: string; head?: boolean } = {},
): Safe {
  const cols = columns.map((c): [string, "left" | "right"] => (typeof c === "string" ? [c, "left"] : c))
  const span = cols.length
  const out: string[] = []
  if (head) {
    out.push(rule(span))
    out.push(
      `<tr>${cols
        .map(
          ([c, a]) =>
            `<th class="m-muted m-cell" align="${a}" style="padding:9px 16px 8px;color:${MUTED};font-size:12.5px;font-weight:600;text-align:${a};">${e(c, "m-muted")}</th>`,
        )
        .join("")}</tr>`,
    )
  }
  for (const row of rows) {
    out.push(rule(span))
    out.push(
      `<tr>${cols
        .map(
          ([, a], i) =>
            `<td class="m-ink m-cell" align="${a}" valign="top" style="padding:9px 16px;color:${INK};font-size:14px;line-height:1.45;text-align:${a};${a === "right" ? "white-space:nowrap;" : "overflow-wrap:break-word;"}">${lines(row[i])}</td>`,
        )
        .join("")}</tr>`,
    )
  }
  if (!rows.length) {
    out.push(rule(span))
    out.push(
      `<tr><td colspan="${span}" class="m-muted m-cell" style="padding:12px 16px;color:${MUTED};font-size:14px;">${e(empty, "m-muted")}</td></tr>`,
    )
  }
  return new Safe(`<table ${TABLE}>${out.join("")}</table>`)
}

/** A grey panel with a heading, as a console panel. */
export function panel(title: Text, blocks: Safe[], { count, note }: { count?: Text; note?: Text } = {}): Safe {
  const countHtml =
    count !== undefined && count !== null
      ? ` <span class="m-muted" style="color:${MUTED};font-weight:500;">${e(count, "m-muted")}</span>`
      : ""
  const noteHtml = note
    ? `<br><span class="m-muted" style="color:${MUTED};font-size:12.5px;font-weight:400;">${e(note, "m-muted")}</span>`
    : ""
  return new Safe(
    `<table ${TABLE} class="m-panel" bgcolor="${PANEL}" style="background-color:${PANEL};border-radius:12px;">` +
      `<tr><td class="m-ink m-cell" style="padding:13px 16px 9px;color:${INK};font-size:15px;"><span class="m-b" style="font-weight:650;">${e(title)}</span>${countHtml}${noteHtml}</td></tr>` +
      blocks.map((b) => `<tr><td>${b.html}</td></tr>`).join("") +
      spacer(4) +
      `</table>`,
  )
}

/** Free text inside a panel, with the panel padding. */
export function panelText(text: Text): Safe {
  return new Safe(
    `<table ${TABLE}>${rule()}<tr><td class="m-ink m-cell" style="padding:10px 16px 12px;color:${INK};font-size:14px;line-height:1.55;">${lines(text)}</td></tr></table>`,
  )
}

/** The n8n-ops mark: the ink tile with an "n", as in the console. A plain cell, so every client draws it
 * without loading anything; Word draws it square. */
const MARK = `<td class="m-mark m-b" width="26" height="26" align="center" valign="middle" bgcolor="${INK}" style="width:26px;height:26px;background-color:${INK};border-radius:7px;color:${BG};font-size:14px;font-weight:800;line-height:26px;text-align:center;">n</td>`

export type Email = { subject: string; text: string; html: string }

/**
 * A full email.
 * - title: the headline, a sentence that says what happened
 * - topic: what kind of email this is, shown as a tag above the title
 * - intro: one or two sentences under the title
 * - blocks: output of panel(), banner(), stats(), paragraph(), button()
 * - footer: why the reader gets this email and where to change it
 */
export function render({
  title,
  topic,
  tone: t = "muted",
  intro,
  blocks = [],
  footer,
  preheader,
  when = new Date(),
  timeZone = "UTC",
}: {
  title: string
  topic: string
  tone?: Tone
  intro?: string
  blocks?: Safe[]
  footer?: string
  preheader?: string
  when?: Date
  timeZone?: string
}): string {
  const date = formatDate(when, timeZone, true)
  const pre = preheader ?? intro
  const preHtml = pre
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${attr(pre)}${"&nbsp;&zwnj;".repeat(40)}</div>`
    : ""
  const introHtml = intro
    ? `<tr><td class="m-muted" style="padding:10px 0 0;color:${MUTED};font-size:16px;line-height:1.5;">${lines(intro, "m-muted")}</td></tr>`
    : ""
  const footerText = `Sent by n8n-ops.${footer ? ` ${lines(footer, "m-muted")}` : ""}`
  const blocksHtml = blocks.map((b) => `<tr><td style="padding:0 0 14px;">${b.html}</td></tr>`).join("")

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${attr(title)}</title>
<style>${DARK_CSS}</style>
${MSO_CSS}
</head>
<body class="m-bg" style="margin:0;padding:0;background-color:${BG};-webkit-text-size-adjust:100%;">
${preHtml}
<table role="presentation" class="m-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BG};">
<tr><td align="center" class="m-wrap" style="padding:32px 24px;">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;font-family:${FONT};">
<tr><td style="padding:0 0 28px;">
  <table ${TABLE}><tr>
    ${MARK}
    <td class="m-ink m-b" style="padding-left:10px;color:${INK};font-size:15px;font-weight:700;letter-spacing:-0.01em;">n8n-ops</td>
    <td class="m-muted" align="right" style="color:${MUTED};font-size:13px;white-space:nowrap;">${e(date, "m-muted")}</td>
  </tr></table>
</td></tr>
<tr><td style="padding:0 0 24px;">
  <table ${TABLE}>
  <tr><td>${tagHtml(topic, t, true)}</td></tr>
  <tr><td class="m-ink m-h1 m-b" style="padding:12px 0 0;color:${INK};font-size:30px;line-height:1.15;font-weight:800;letter-spacing:-0.03em;">
    <h1 class="m-ink m-h1" style="margin:0;font-size:30px;line-height:1.15;font-weight:800;color:${INK};">${e(title)}</h1></td></tr>
  ${introHtml}
  </table>
</td></tr>
${blocksHtml}
<tr><td class="m-muted m-line" style="padding:18px 0 0;border-top:1px solid ${LINE};color:${MUTED};font-size:12.5px;line-height:1.5;">
  ${footerText}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`
}

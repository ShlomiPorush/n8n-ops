import { type DateWriting, formatDay, formatStamp, messageWriting } from "@n8n-ops/shared"

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

function attr(value: Text): string {
  if (value instanceof Safe) return value.html
  return escapeText(value === null || value === undefined ? "" : String(value))
}

export const FONT = "Onest, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
export const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

const BG = "#FFFFFF"
const PANEL = "#EEEEEE"
const INK = "#111814"
const MUTED = "#5E6863"
const LINE = "#E0E0E0"
const SOLID = "#141414"

const TONES: Record<Tone, string> = {
  ok: "#12803F",
  warn: "#9A6200",
  fail: "#C42B1C",
  info: "#1F5FBF",
  muted: "#5E6863",
}
const tone = (t?: Tone | null) => TONES[t ?? "muted"] ?? TONES.muted
const CLASS_COLORS: Record<string, string> = {
  "m-ink": INK,
  "m-muted": MUTED,
  ...Object.fromEntries(Object.entries(TONES).map(([t, c]) => [`m-${t}`, c])),
}

const ADDRESS_RUN = /[A-Za-z0-9._%+@-]+/g
const DOMAIN_LABEL = /^[A-Za-z0-9-]+$/

function isAddress(text: string): boolean {
  const at = text.indexOf("@")
  if (at <= 0 || text.indexOf("@", at + 1) >= 0) return false
  const labels = text.slice(at + 1).split(".")
  return labels.length >= 2 && labels.every((l) => DOMAIN_LABEL.test(l))
}

function e(value: Text, cls = "m-ink"): string {
  if (value instanceof Safe) return value.html
  const color = CLASS_COLORS[cls] ?? INK
  return attr(value).replace(ADDRESS_RUN, (run) => {
    const address = run.replace(/\.+$/, "")
    if (!isAddress(address)) return run
    return `<a href="mailto:${address}" class="${cls}" style="color:${color};text-decoration:none;">${address}</a>${run.slice(address.length)}`
  })
}

function lines(value: Text, cls = "m-ink"): string {
  if (value instanceof Safe) return value.html
  return e(value, cls).replace(/\n/g, "<br>")
}

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`

export function formatDate(when: Date, dates: DateWriting, time = false): string {
  return time ? formatStamp(when, dates, { zone: false }) : formatDay(when, dates)
}

const DARK_CSS = `
:root { color-scheme: light dark; supported-color-schemes: light dark; }
.m-bg a { color: inherit !important; text-decoration: none !important; }
@media (prefers-color-scheme: dark) {
  .m-bg { background-color: #141414 !important; }
  .m-panel { background-color: #202020 !important; }
  .m-ink { color: #F2F5F3 !important; }
  .m-muted { color: #97A29C !important; border-color: #97A29C !important; }
  .m-line { border-color: #333333 !important; }
  .m-rule { background-color: #333333 !important; }
  .m-mark { background-color: #E0E0E0 !important; color: #141414 !important; }
  .m-ok { color: #3FCF7F !important; border-color: #3FCF7F !important; }
  .m-warn { color: #F0B03F !important; border-color: #F0B03F !important; }
  .m-fail { color: #FF6B61 !important; border-color: #FF6B61 !important; }
  .m-info { color: #7DB3FF !important; border-color: #7DB3FF !important; }
}
[data-ogsb] .m-bg { background-color: #FFFFFF !important; }
[data-ogsb] .m-panel { background-color: #202020 !important; }
[data-ogsb] .m-line { border-color: #333333 !important; }
[data-ogsb] .m-rule { background-color: #333333 !important; }
[data-ogsb] .m-mark { background-color: #333333 !important; color: #FFFFFF !important; }
@media (max-width: 620px) {
  .m-wrap { padding: 24px 16px !important; }
  .m-h1 { font-size: 26px !important; }
  .m-stat { padding: 9px 10px !important; }
  .m-stat-v { font-size: 20px !important; }
  .m-cell { padding-left: 10px !important; padding-right: 10px !important; }
  .m-bullet { padding-left: 10px !important; }
}
`

const MSO_CSS = `<!--[if mso]><style>
v\\:* { behavior: url(#default#VML); display: inline-block; }
body, table, td, th, p, a, span, h1, div { font-family: 'Segoe UI', Arial, sans-serif !important; }
.m-mono { font-family: Consolas, 'Courier New', monospace !important; }
.m-b { font-weight: bold !important; }
</style><![endif]-->`

const TABLE = 'role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"'
const spacer = (px: number) =>
  `<tr><td height="${px}" style="height:${px}px;font-size:1px;line-height:1px;">&nbsp;</td></tr>`

const rule = (colspan = 1) =>
  `<tr><td class="m-rule" colspan="${colspan}" height="1" style="height:1px;font-size:1px;line-height:1px;mso-line-height-rule:exactly;background-color:${LINE};">&nbsp;</td></tr>`

function tagHtml(text: string, t: Tone, roundedInOutlook: boolean): string {
  const color = tone(t)
  const cell =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table;vertical-align:middle;">` +
    `<tr><td class="m-${t} m-b" style="padding:1px 7px;border:1px solid ${color};border-radius:6px;color:${color};font-size:12px;font-weight:700;line-height:1.4;white-space:nowrap;">` +
    `${e(text, `m-${t}`)}</td></tr></table>`
  if (!roundedInOutlook) return cell
  const width = text.length * 7 + 18
  return (
    `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" arcsize="30%" filled="f" strokecolor="${color}" strokeweight="1px" ` +
    `style="width:${(width * 3) / 4}pt;height:15pt;v-text-anchor:middle;"><v:textbox inset="0,0,0,0">` +
    `<center style="color:${color};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:bold;">` +
    `${attr(text)}</center></v:textbox></v:roundrect><![endif]-->` +
    `<!--[if !mso]><!-->${cell}<!--<![endif]-->`
  )
}

export const tag = (text: string, t: Tone = "muted") => new Safe(tagHtml(text, t, false))

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

export function button(text: string, url: string | null | undefined): Safe {
  if (!url || !/^https?:\/\//i.test(url)) return new Safe("")
  return new Safe(
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
      `<td class="m-mark" bgcolor="${SOLID}" style="padding:10px 18px;background-color:${SOLID};border-radius:8px;color:${BG};">` +
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

export type Stat = { label: string; value: Text; tone?: Tone; note?: string }

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
      const color = item.tone ? tone(item.tone) : INK
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
  // Without the empty last row, Outlook drops the bottom border of the cards above it.
  return new Safe(
    `<table ${TABLE}>${rows.map((row, i) => `<tr><td style="padding:${i ? "8px" : "0"} 0 0;">${row}</td></tr>`).join("")}${spacer(1)}</table>`,
  )
}

export function kv(rows: [label: string, value: Text, tone?: Tone][]): Safe {
  const out = rows.map(([label, value, t]) => {
    const color = t ? tone(t) : INK
    const vcls = t ? `m-${t}` : "m-ink"
    const shown = value instanceof Safe ? value.html : `<b style="font-weight:650;">${lines(value, vcls)}</b>`
    return (
      rule(2) +
      `<tr><td class="m-muted m-cell" valign="top" style="padding:9px 16px;color:${MUTED};font-size:14px;">${e(label, "m-muted")}</td>` +
      `<td class="${vcls} m-cell" valign="top" align="right" style="padding:9px 16px;color:${color};font-size:14px;text-align:right;overflow-wrap:break-word;">${shown}</td></tr>`
    )
  })
  return new Safe(`<table ${TABLE}>${out.join("")}</table>`)
}

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

export function panelText(text: Text, dir: "ltr" | "rtl" = "ltr"): Safe {
  const rtl = dir === "rtl" ? ' dir="rtl" align="right"' : ""
  const align = dir === "rtl" ? "text-align:right;" : ""
  return new Safe(
    `<table ${TABLE}>${rule()}<tr><td${rtl} class="m-ink m-cell" style="padding:10px 16px 12px;color:${INK};font-size:14px;line-height:1.55;${align}">${lines(text)}</td></tr></table>`,
  )
}

export function bullets(items: Text[]): Safe {
  const cell = `color:${INK};font-size:14px;line-height:1.55;`
  const rows = items.map((item, i) => {
    const pad = `${i ? 2 : 10}px`
    const bottom = `${i === items.length - 1 ? 12 : 2}px`
    return (
      `<tr><td class="m-ink m-bullet" valign="top" width="14" style="width:14px;padding:${pad} 0 ${bottom} 16px;${cell}">&bull;</td>` +
      `<td class="m-ink" valign="top" style="padding:${pad} 16px ${bottom} 0;${cell}overflow-wrap:break-word;">${lines(item)}</td></tr>`
    )
  })
  return new Safe(`<table ${TABLE}>${rule(2)}${rows.join("")}</table>`)
}

const MARK = `<td class="m-mark m-b" width="26" height="26" align="center" valign="middle" bgcolor="${SOLID}" style="width:26px;height:26px;background-color:${SOLID};border-radius:7px;color:${BG};font-size:14px;font-weight:800;line-height:26px;text-align:center;">n</td>`

export type Email = { subject: string; text: string; html: string }

export function render({
  title,
  topic,
  tone: t = "muted",
  intro,
  blocks = [],
  footer,
  preheader,
  when = new Date(),
  dates = messageWriting(undefined),
}: {
  title: string
  topic: string
  tone?: Tone
  intro?: string
  blocks?: Safe[]
  footer?: string
  preheader?: string
  when?: Date
  dates?: DateWriting
}): string {
  const date = formatDate(when, dates, true)
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
<html lang="en" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${attr(title)}</title>
<style>${DARK_CSS}</style>
${MSO_CSS}
</head>
<body class="m-bg" dir="ltr" style="margin:0;padding:0;background-color:${BG};-webkit-text-size-adjust:100%;">
${preHtml}
<table role="presentation" class="m-bg" dir="ltr" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BG};">
<tr><td align="center" class="m-wrap" style="padding:32px 24px;">
<!--[if mso]><table role="presentation" dir="ltr" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" dir="ltr" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;font-family:${FONT};">
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

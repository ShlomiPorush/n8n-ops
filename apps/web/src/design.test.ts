import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

// Guards for the design system: every visual value comes from the tokens in index.css, colour means
// status, and nothing is loaded from another server.

const src = import.meta.dirname
const web = join(src, "..")

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path, ext)
    return ext.test(name) && !name.endsWith(".test.ts") ? [path] : []
  })
}

const sources = files(src, /\.tsx?$/).map((path) => ({ path: relative(web, path), text: readFileSync(path, "utf8") }))

function offenders(pattern: RegExp) {
  return sources.flatMap(({ path, text }) =>
    text.split("\n").flatMap((line, i) => (pattern.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])),
  )
}

describe("design tokens", () => {
  it("uses no raw hex colours in components", () => {
    expect(offenders(/#[0-9a-fA-F]{3,8}\b(?![\w-])/)).toEqual([])
  })

  it("uses no colours from the Tailwind palette, only the status and surface tokens", () => {
    const palette =
      /\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/
    expect(offenders(palette)).toEqual([])
  })

  it("uses only the type scale for font sizes", () => {
    expect(offenders(/\btext-(?:xs|sm|base|lg|[2-9]?xl)\b/)).toEqual([])
  })

  it("uses no raw font sizes, radii or shadows: they are tokens, so each design can set them", () => {
    expect(offenders(/\b(?:text|rounded(?:-[a-z]{1,2})?|shadow|tracking)-\[/)).toEqual([])
  })
})

// The two designs are one app with the same functions; only the look differs. So only the design module
// reads or sets the design, only the sync applies it, and only the presentational skin components may
// draw something differently. Everything else may differ by class only, through the regular: and compact:
// variants, which change how a thing looks and never what it is or does.
describe("one app, two looks", () => {
  const rel = (path: string) => path.replaceAll("\\", "/")

  it("reads and sets the design attribute in lib/design.ts only", () => {
    const found = sources
      .filter(({ path }) => rel(path) !== "src/lib/design.ts")
      .filter(({ text }) => /data-design|dataset\.design|["']data-design["']/.test(text))
      .map(({ path }) => rel(path))
    expect(found).toEqual([])
  })

  it("imports lib/design.ts only in the sync, the entry point and the skin components", () => {
    const allowed = (path: string) =>
      path === "src/app/design-sync.tsx" || path === "src/main.tsx" || path.startsWith("src/components/skin/")
    const found = sources
      .filter(({ text }) => /from\s+["'](?:@\/lib\/design|(?:\.\.?\/)+(?:lib\/)?design)(?:\.ts)?["']/.test(text))
      .map(({ path }) => rel(path))
      .filter((path) => !allowed(path))
    expect(found).toEqual([])
  })

  it("calls useDesign only in the skin components, which only draw", () => {
    const found = sources
      .filter(({ text }) => /\buseDesign\(/.test(text))
      .map(({ path }) => rel(path))
      .filter((path) => path !== "src/lib/design.ts" && !path.startsWith("src/components/skin/"))
    expect(found).toEqual([])
    const acting = sources
      .filter(({ path }) => rel(path).startsWith("src/components/skin/"))
      .filter(({ text }) =>
        /\bon[A-Z]\w*=|\bhref=|\bto=|<Link\b|\bnavigate\(|\buseApi\b|\buseMutation\b|\bfetch\(/.test(text),
      )
      .map(({ path }) => rel(path))
    expect(acting).toEqual([])
  })

  it("lets the design change classes only, never the markup an attribute or handler depends on", () => {
    // Every string that names a design variant must be made of classes only; a variant anywhere else would
    // be a design-dependent value.
    const classLike = /^[!-]?[\w@:[\]/.%()&>*=,#'+-]+$/
    const found = sources.flatMap(({ path, text }) =>
      [...text.matchAll(/(["'`])((?:(?!\1)[^\\\n])*\b(?:regular|compact):(?:(?!\1)[^\\\n])*)\1/g)]
        .map((m) => m[2] ?? "")
        .filter(
          (s) =>
            !s
              .split(/\s+/)
              .filter(Boolean)
              .every((token) => classLike.test(token)),
        )
        .map((s) => `${rel(path)}: ${s}`),
    )
    expect(found).toEqual([])
    // Nor in an attribute other than className (a title, a label, a value).
    expect(offenders(/\b(?!className\b)[a-zA-Z-]+=\{?["'`][^"'`]*\b(?:regular|compact):/)).toEqual([])
    // And no variant outside a string at all.
    const bare = offenders(/\b(?:regular|compact):[\w[]/).filter(
      (line) => !/["'`][^"'`]*\b(?:regular|compact):/.test(line),
    )
    expect(bare).toEqual([])
  })
})

// Every date and time on screen is written by the helpers in lib/time.ts, which follow the Date format, the Time
// format and the app's time zone (FW-9, FW-2). A page or component that formats a date itself would bypass all
// three, so none may: no locale or ISO strings of a date, no Intl.DateTimeFormat or clock options of its own, no
// getHours() and the like (the browser's zone), no date library.
describe("dates and times", () => {
  const formatting =
    /\.(?:toLocaleDateString|toLocaleTimeString|toLocaleString|toISOString|toUTCString|toDateString|toTimeString|toGMTString)\s*\(|\bIntl\.DateTimeFormat\b|\b(?:hour12|hourCycle|dateStyle|timeStyle)\b|\.get(?:UTC)?(?:FullYear|Month|Date|Day|Hours|Minutes|Seconds)\s*\(|from\s+["'](?:date-fns|dayjs|moment|luxon)(?:[/"'])/
  // The places allowed to, by file, with what they may use and why.
  const allowed = [
    // formatTime, formatDay, formatListTime, isoTime and the rest: the helpers themselves.
    { file: "src/lib/time.ts", what: formatting },
    // zoneOffset: reads a zone's offset for the Time zone list (MP-4); it writes no date.
    { file: "src/components/time-zone-picker.tsx", what: /\bIntl\.DateTimeFormat\b/ },
    // count and formatSize: numbers with thousands separators (FW-3, FW-4), not dates.
    { file: "src/lib/numbers.ts", what: /\.toLocaleString\s*\(/ },
  ]
  const rel = (path: string) => path.replaceAll("\\", "/")

  it("formats dates only through lib/time.ts (FW-9)", () => {
    const found = sources.flatMap(({ path, text }) =>
      text.split("\n").flatMap((line, i) => {
        if (!formatting.test(line)) return []
        const here = allowed.filter((a) => a.file === rel(path))
        // A line passes only when what it uses is what its file is allowed.
        const rest = here.reduce((l, a) => l.replace(new RegExp(a.what.source, "g"), ""), line)
        return here.length && !formatting.test(rest) ? [] : [`${rel(path)}:${i + 1}: ${line.trim()}`]
      }),
    )
    expect(found).toEqual([])
  })

  it("catches each way a page could format a date itself", () => {
    for (const line of [
      "new Date(x).toLocaleDateString()",
      "d.toLocaleTimeString([], { hour: '2-digit' })",
      "when.toLocaleString('en-GB')",
      "<time dateTime={d.toISOString()}>",
      "new Intl.DateTimeFormat(undefined, { timeZone })",
      "{ hour12: false }",
      "d.getHours()",
      'import { format } from "date-fns"',
    ])
      expect(line).toMatch(formatting)
    for (const line of ["d.getTime()", "Date.now()", "new Date(value)", "formatTime(value, w)"])
      expect(line).not.toMatch(formatting)
  })
})

describe("assets", () => {
  it("loads no script, stylesheet or font from another server", () => {
    const html = readFileSync(join(web, "index.html"), "utf8")
    const css = readFileSync(join(src, "index.css"), "utf8")
    expect(html).not.toMatch(/(?:src|href)=["']https?:\/\//)
    expect(css).not.toMatch(/url\(\s*["']?https?:\/\//)
    expect(css).not.toMatch(/@import\s+(?:url\()?["']?https?:\/\//)
  })
})

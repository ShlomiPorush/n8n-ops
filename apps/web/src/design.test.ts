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

describe("assets", () => {
  it("loads no script, stylesheet or font from another server", () => {
    const html = readFileSync(join(web, "index.html"), "utf8")
    const css = readFileSync(join(src, "index.css"), "utf8")
    expect(html).not.toMatch(/(?:src|href)=["']https?:\/\//)
    expect(css).not.toMatch(/url\(\s*["']?https?:\/\//)
    expect(css).not.toMatch(/@import\s+(?:url\()?["']?https?:\/\//)
  })
})

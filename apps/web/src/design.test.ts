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

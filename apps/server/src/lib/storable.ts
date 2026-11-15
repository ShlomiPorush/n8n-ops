const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * Text PostgreSQL can keep. Its text and jsonb types refuse U+0000, and jsonb refuses an unpaired UTF-16 surrogate,
 * so both are removed; paired surrogates stay.
 */
export function storableText(text: string): string {
  return text.replaceAll("\u0000", "").replace(UNPAIRED_SURROGATE, "")
}

/** The start of `text` that takes at most `maxBytes` bytes in UTF-8, cut between characters. */
export function cutToBytes(text: string, maxBytes: number): string {
  // A UTF-16 code unit takes at most three bytes in UTF-8.
  if (text.length * 3 <= maxBytes) return text
  // encodeInto writes whole characters only and says how much of the text it read.
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(maxBytes))
  return text.slice(0, read)
}

type Container = Record<string, unknown> | unknown[]

const isContainer = (value: unknown): value is Container => !!value && typeof value === "object"

/**
 * Cleans a value parsed from JSON in place, so every string in it, object keys included, is storableText. It walks
 * without recursion, so no nesting depth makes it throw. Properties are defined, never assigned, so a "__proto__" key
 * stays an own property. Keys that clean to the same key keep the later value, as jsonb does with duplicate keys.
 */
export function makeStorable(value: unknown): void {
  if (!isContainer(value)) return
  const pending: Container[] = [value]
  const seen = new Set<Container>()
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (seen.has(node)) continue
    seen.add(node)
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const item = node[i]
        if (typeof item === "string") node[i] = storableText(item)
        else if (isContainer(item)) pending.push(item)
      }
      continue
    }
    const object = node
    const keys = Object.keys(object)
    const rename = keys.some((key) => storableText(key) !== key)
    const entries = keys.map((key) => [key, object[key]] as const)
    if (rename) for (const key of keys) delete object[key]
    for (const [key, item] of entries) {
      if (isContainer(item)) pending.push(item)
      const clean = typeof item === "string" ? storableText(item) : item
      if (rename || clean !== item)
        Object.defineProperty(object, storableText(key), {
          value: clean,
          writable: true,
          enumerable: true,
          configurable: true,
        })
    }
  }
}

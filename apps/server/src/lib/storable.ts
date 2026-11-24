const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

export function storableText(text: string): string {
  return text.replaceAll("\u0000", "").replace(UNPAIRED_SURROGATE, "")
}

export function cutToBytes(text: string, maxBytes: number): string {
  if (text.length * 3 <= maxBytes) return text
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(maxBytes))
  return text.slice(0, read)
}

type Container = Record<string, unknown> | unknown[]

const isContainer = (value: unknown): value is Container => !!value && typeof value === "object"

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

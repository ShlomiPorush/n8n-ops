/**
 * Minimal POSIX ustar reader and writer for backup archives (regular files and directories only).
 * Archives are small (workflow and credential JSON), so everything stays in memory.
 */

export type TarEntry = { name: string; data: Uint8Array }

const BLOCK = 512
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function writeString(block: Uint8Array, offset: number, length: number, value: string) {
  const bytes = encoder.encode(value)
  block.set(bytes.subarray(0, length), offset)
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number) {
  writeString(block, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`)
}

function header(name: string, size: number, type: "0" | "5", mtime: number): Uint8Array {
  const block = new Uint8Array(BLOCK)
  let prefix = ""
  let short = name
  if (encoder.encode(name).length > 100) {
    const cut = name.lastIndexOf("/", 155)
    if (cut <= 0 || encoder.encode(name.slice(cut + 1)).length > 100) throw new Error(`path too long for tar: ${name}`)
    prefix = name.slice(0, cut)
    short = name.slice(cut + 1)
  }
  writeString(block, 0, 100, short)
  writeOctal(block, 100, 8, type === "5" ? 0o755 : 0o644)
  writeOctal(block, 108, 8, 0)
  writeOctal(block, 116, 8, 0)
  writeOctal(block, 124, 12, size)
  writeOctal(block, 136, 12, Math.floor(mtime / 1000))
  block.fill(0x20, 148, 156)
  writeString(block, 156, 1, type)
  writeString(block, 257, 6, "ustar\0")
  writeString(block, 263, 2, "00")
  writeString(block, 345, 155, prefix)
  const sum = block.reduce((a, b) => a + b, 0)
  writeString(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `)
  return block
}

export function createTar(entries: TarEntry[], mtime = Date.now()): Uint8Array {
  const parts: Uint8Array[] = []
  for (const entry of entries) {
    parts.push(header(entry.name, entry.data.length, "0", mtime))
    parts.push(entry.data)
    const pad = (BLOCK - (entry.data.length % BLOCK)) % BLOCK
    if (pad) parts.push(new Uint8Array(pad))
  }
  parts.push(new Uint8Array(BLOCK * 2))
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

function readString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end))
}

/** Reads regular files from a tar archive. Paths are normalised (no leading "./"). */
export function readTar(archive: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  let longName: string | null = null
  while (offset + BLOCK <= archive.length) {
    const block = archive.subarray(offset, offset + BLOCK)
    if (block.every((b) => b === 0)) break
    const size = Number.parseInt(readString(block, 124, 12).trim() || "0", 8)
    const type = String.fromCharCode(block[156] ?? 0)
    const prefix = readString(block, 345, 155)
    const name = longName ?? (prefix ? `${prefix}/${readString(block, 0, 100)}` : readString(block, 0, 100))
    longName = null
    const data = archive.subarray(offset + BLOCK, offset + BLOCK + size)
    // A GNU long name ends at its first NUL (read in linear time; a trailing-NUL regex is quadratic).
    if (type === "L") longName = readString(data, 0, data.length)
    else if (type === "0" || type === "\0") entries.push({ name: name.replace(/^\.\//, ""), data: data.slice() })
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK
  }
  return entries
}

export const textEntry = (name: string, text: string): TarEntry => ({ name, data: encoder.encode(text) })
export const entryText = (entry: TarEntry) => decoder.decode(entry.data)

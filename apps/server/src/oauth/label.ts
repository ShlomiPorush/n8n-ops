export function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const label = raw.normalize("NFC").trim()
  const length = [...label].length
  if (length < 1 || length > 60) return null
  return /^[\p{L}\p{M}\p{N} ._\-()@:/]+$/u.test(label) ? label : null
}

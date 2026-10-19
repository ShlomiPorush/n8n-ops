/**
 * A script's name for itself, sent with its code request (`client_label`): shown on the code pages and the
 * approval page as its own word, and the name of its connection. Kept only when it is plain text: letters,
 * marks, digits, spaces and . - _ ( ) @ : /, 1 to 60 characters. Anything else (control or direction marks,
 * quotes, markup) drops it, and the script is called "Script".
 */
export function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const label = raw.normalize("NFC").trim()
  const length = [...label].length
  if (length < 1 || length > 60) return null
  return /^[\p{L}\p{M}\p{N} ._\-()@:/]+$/u.test(label) ? label : null
}

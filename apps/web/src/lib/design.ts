/*
 * The two designs of the installation, chosen in Settings → General → Design. They differ only in how things
 * look: the server writes the choice on <html data-design> before the page draws, the CSS tokens and the
 * regular: and compact: variants follow it, and this is the only module that reads or changes it. Functions,
 * texts and behaviour never depend on it.
 */
export const designs = ["regular", "compact"] as const
export type Design = (typeof designs)[number]

const isDesign = (value: unknown): value is Design => designs.includes(value as Design)
const root = () => document.documentElement

let pinned = false

/** Shows a design at once, without a reload. Anything that is not a design is ignored. */
export function applyDesign(value: unknown) {
  if (pinned || !isDesign(value) || root().dataset.design === value) return
  root().dataset.design = value
}

/** Development previews only: shows a design and keeps it, whatever the setting says. */
export function pinDesign(value: unknown) {
  if (!isDesign(value)) return
  applyDesign(value)
  pinned = true
}

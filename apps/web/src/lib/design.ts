import { useSyncExternalStore } from "react"

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

/** The design on the page now; an unknown value counts as the default. */
export function currentDesign(): Design {
  const value = root().dataset.design
  return isDesign(value) ? value : "regular"
}

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

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(root(), { attributes: true, attributeFilter: ["data-design"] })
  return () => observer.disconnect()
}

/** For the skin components only: which design to draw, re-rendering when it changes. */
export function useDesign(): Design {
  return useSyncExternalStore(subscribe, currentDesign, () => "regular")
}

/*
 * A layer that is not a Radix dialog (the phone search) makes everything beside it inert while it is open (DS-8):
 * every element off the path from the page to the layer, except the toast's wrapper, which must stay usable.
 * The Toaster draws that wrapper even while no toast shows, so a toast that shows after the layer opened is
 * inside it and usable too.
 */

/** The toast's wrapper, always there; it stays usable over every layer. */
const KEEP = '[data-slot="toaster"]'

/** Makes everything beside `layer` inert, and returns what undoes exactly that. */
export function inertBeside(layer: Element, root: Element = document.body): () => void {
  const set: Element[] = []
  const walk = (parent: Element) => {
    for (const el of parent.children) {
      if (el === layer || el.matches(KEEP)) continue
      // On the path to the layer or to the toast: only what is beside it goes.
      if (el.contains(layer) || el.querySelector(KEEP)) walk(el)
      else if (!el.hasAttribute("inert") && el.tagName !== "SCRIPT" && el.tagName !== "STYLE") {
        el.setAttribute("inert", "")
        set.push(el)
      }
    }
  }
  walk(root)
  return () => {
    for (const el of set) el.removeAttribute("inert")
  }
}

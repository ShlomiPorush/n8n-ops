const KEEP = '[data-slot="toaster"]'

export function inertBeside(layer: Element, root: Element = document.body): () => void {
  const set: Element[] = []
  const walk = (parent: Element) => {
    for (const el of parent.children) {
      if (el === layer || el.matches(KEEP)) continue
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

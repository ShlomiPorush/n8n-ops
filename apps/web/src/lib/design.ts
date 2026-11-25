export const designs = ["regular", "compact"] as const
export type Design = (typeof designs)[number]

const isDesign = (value: unknown): value is Design => designs.includes(value as Design)
const root = () => document.documentElement

let pinned = false

export function applyDesign(value: unknown) {
  if (pinned || !isDesign(value) || root().dataset.design === value) return
  root().dataset.design = value
}

export function pinDesign(value: unknown) {
  if (!isDesign(value)) return
  applyDesign(value)
  pinned = true
}

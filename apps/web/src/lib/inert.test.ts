import { describe, expect, it } from "vitest"
import { inertBeside } from "./inert.ts"

/** Just enough of an element for the walk: children, attributes, matches, contains and querySelector. */
class Fake {
  children: Fake[] = []
  attrs = new Set<string>()
  constructor(
    readonly name: string,
    readonly tagName = "DIV",
    readonly toaster = false,
  ) {}
  with(...children: Fake[]) {
    this.children.push(...children)
    return this
  }
  matches() {
    return this.toaster
  }
  contains(other: Fake): boolean {
    return other === this || this.children.some((c) => c.contains(other))
  }
  querySelector(): Fake | null {
    for (const c of this.children) {
      if (c.toaster) return c
      const found = c.querySelector()
      if (found) return found
    }
    return null
  }
  hasAttribute(name: string) {
    return this.attrs.has(name)
  }
  setAttribute(name: string) {
    this.attrs.add(name)
  }
  removeAttribute(name: string) {
    this.attrs.delete(name)
  }
}

describe("a layer makes the page beside it inert (DS-8)", () => {
  // body > #root (page, toaster), a portal, the layer, a script
  const page = new Fake("page")
  const toaster = new Fake("toaster", "DIV", true)
  const root = new Fake("root").with(page, toaster)
  const portal = new Fake("portal")
  const already = new Fake("already")
  already.attrs.add("inert")
  const layer = new Fake("layer")
  const script = new Fake("script", "SCRIPT")
  const body = new Fake("body").with(root, portal, already, layer, script)
  const inert = () =>
    [page, toaster, root, portal, already, layer, script].filter((el) => el.attrs.has("inert")).map((el) => el.name)

  it("leaves the layer, the toast and the elements on their path usable, and undoes only what it set", () => {
    const undo = inertBeside(layer as unknown as Element, body as unknown as Element)
    expect(inert()).toEqual(["page", "portal", "already"])
    undo()
    expect(inert()).toEqual(["already"])
  })
})

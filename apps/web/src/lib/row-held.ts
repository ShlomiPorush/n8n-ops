import { ROW_HOLD_MOVE_PX } from "@/lib/behavior"

type Point = { x: number; y: number }
type Click = { detail: number; shiftKey: boolean; clientX: number; clientY: number }
type SelectionLike = Pick<Selection, "isCollapsed" | "rangeCount"> & {
  getRangeAt: (index: number) => Pick<Range, "intersectsNode">
}

let pressedAt: Point | null = null
if (typeof document !== "undefined")
  document.addEventListener(
    "mousedown",
    (e) => {
      pressedAt = { x: e.clientX, y: e.clientY }
    },
    true,
  )

export function selectingGesture(click: Click, start: Point | null): boolean {
  if (click.detail === 0) return false
  if (click.detail > 1 || click.shiftKey) return true
  if (!start) return false
  return Math.hypot(click.clientX - start.x, click.clientY - start.y) > ROW_HOLD_MOVE_PX
}

export function selectionTouches(selection: SelectionLike | null, node: Node): boolean {
  if (!selection || selection.isCollapsed) return false
  for (let i = 0; i < selection.rangeCount; i++) if (selection.getRangeAt(i).intersectsNode(node)) return true
  return false
}

export function rowHeld(event: Click & { currentTarget: EventTarget | null }): boolean {
  const row = event.currentTarget as Node | null
  if (event.detail === 0 || !row) return false
  return selectingGesture(event, pressedAt) && selectionTouches(window.getSelection(), row)
}

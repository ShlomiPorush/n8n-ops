import { ROW_HOLD_MOVE_PX } from "@/lib/behavior"

/*
 * A row that opens on click holds when the click ends selecting text in it, so values can be copied (TB-8).
 * Only the gesture counts, not the page's selection alone: the press moved more than 3px, it was a double or
 * triple click on a word, or Shift extended a selection. A plain click, also on text that is still selected,
 * opens the row, and so do Enter and Space (their click has `detail` 0). Nothing stops the event, so the rest
 * of the page still gets the click.
 */

type Point = { x: number; y: number }
type Click = { detail: number; shiftKey: boolean; clientX: number; clientY: number }
type SelectionLike = Pick<Selection, "isCollapsed" | "rangeCount"> & {
  getRangeAt: (index: number) => Pick<Range, "intersectsNode">
}

/** Where the last press started, recorded before anything else sees it. */
let pressedAt: Point | null = null
if (typeof document !== "undefined")
  document.addEventListener(
    "mousedown",
    (e) => {
      pressedAt = { x: e.clientX, y: e.clientY }
    },
    true,
  )

/** Whether a click ends a selecting gesture: moved since the press, a double or triple click, or Shift. */
export function selectingGesture(click: Click, start: Point | null): boolean {
  if (click.detail === 0) return false
  if (click.detail > 1 || click.shiftKey) return true
  if (!start) return false
  return Math.hypot(click.clientX - start.x, click.clientY - start.y) > ROW_HOLD_MOVE_PX
}

/** Whether selected text lies in the node, wholly or in part. */
export function selectionTouches(selection: SelectionLike | null, node: Node): boolean {
  if (!selection || selection.isCollapsed) return false
  for (let i = 0; i < selection.rangeCount; i++) if (selection.getRangeAt(i).intersectsNode(node)) return true
  return false
}

/** Whether a row's click should open nothing, because it ends selecting text in the row. Ask it first. */
export function rowHeld(event: Click & { currentTarget: EventTarget | null }): boolean {
  const row = event.currentTarget as Node | null
  if (event.detail === 0 || !row) return false
  return selectingGesture(event, pressedAt) && selectionTouches(window.getSelection(), row)
}

/*
 * Timings of the shared behaviors, defined once. Each value is the one the v3 behavior rules give.
 */

/** A reloading list keeps its rows and dims them only after this long (TB-5). */
export const DIM_AFTER_MS = 200
/** A copied value shows a check for this long (FB-12). */
export const COPIED_MS = 1500
/** A toast stays this long, then fades (FB-2). */
export const TOAST_MS = 4000
/** How long a toast takes to fade out (FB-2). */
export const TOAST_FADE_MS = 300
/** A toast let go by the pointer or the keyboard stays at least this long, and a fading one caught comes back for it (FB-2). */
export const TOAST_REST_MS = 1500
/** A busy button shows "Done" this long after its request succeeded (FB-7). */
export const DONE_MS = 3000
/** A busy button shows "Failed" this long after its request failed (FB-7). */
export const FAILED_MS = 2000
/** The confirm button, or the safe answer of a question that protects changes, takes the focus after this delay (DS-12). */
export const CONFIRM_FOCUS_MS = 100
/** A sheet pulled down past min(this, a quarter of its height) closes (DS-3). */
export const SHEET_PULL_CLOSE_PX = 120
/** The slide of a closing or springing sheet (DS-3). */
export const SHEET_SLIDE_MS = 200
/** Freshness labels ("Updated 3 min ago") tick on one shared timer (LD-12). */
export const AGO_TICK_MS = 30_000
/** A press that moves more than this before its click was selecting text, so the row holds (TB-8). */
export const ROW_HOLD_MOVE_PX = 3

/** The phone layout: tab bar, sheets instead of dialogs, stacked tables. */
export const PHONE_QUERY = "(max-width: 760px)"

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
/** The confirm button takes the focus after this delay, so Enter confirms (DS-12). */
export const CONFIRM_FOCUS_MS = 100
/** A sheet pulled down past min(this, a quarter of its height) closes (DS-3). */
export const SHEET_PULL_CLOSE_PX = 120
/** The slide of a closing or springing sheet (DS-3). */
export const SHEET_SLIDE_MS = 200
/** Freshness labels ("Updated 3 min ago") tick on one shared timer (LD-12). */
export const AGO_TICK_MS = 30_000
/** A busy button shows Done or Error for this long before its label comes back (FB-7). */
export const DONE_MS = 3000
export const FAILED_MS = 2000

/** The phone layout: tab bar, sheets instead of dialogs, stacked tables. */
export const PHONE_QUERY = "(max-width: 760px)"

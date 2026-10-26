/*
 * Timings of the shared behaviors, defined once. Each value is the one the v3 behavior rules give.
 */

/** A reloading list keeps its rows and dims them only after this long (TB-5). */
export const DIM_AFTER_MS = 200
/** A copied value shows a check for this long (FB-12). */
export const COPIED_MS = 1500
/** A tooltip shown by a tap on a touch screen stays this long (MO-4). */
export const TIP_TAP_MS = 2500
/** The click that follows such a tap within this long belongs to the tooltip, not to what is under it (MO-4). */
export const TIP_TAP_CLICK_MS = 600
/** A toast stays this long, then fades (FB-2). */
export const TOAST_MS = 4000
/** How long a toast takes to fade out (FB-2). */
export const TOAST_FADE_MS = 300
/** A toast let go by the pointer or the keyboard stays at least this long, and a fading one caught comes back for it (FB-2). */
export const TOAST_REST_MS = 1500
/** A toast that offers Undo stays this long, longer while the pointer or the keyboard is on it (FB-16). */
export const UNDO_MS = 10_000
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
/** A list searched on the server asks once typing has paused this long (SR-9). */
export const SEARCH_PAUSE_MS = 300
/** Rows of new filters that take longer than this no longer move their list to its first row (TB-7; the 8 s wait of TB-4). */
export const LIST_WAIT_MS = 8000
/** A press that moves more than this before its click was selecting text, so the row holds (TB-8). */
export const ROW_HOLD_MOVE_PX = 3

/** Needs attention is read again this often on every page, while the browser tab is shown (NL-19). */
export const ATTENTION_POLL_MS = 30_000
/** A read of Needs attention without an answer by then fails, so it never holds the next refresh (NL-19). */
export const ATTENTION_TIMEOUT_MS = 20_000

/** Back and Forward bring a page's scrolling areas back for at most this long while its content loads (NL-3). */
export const SCROLL_RESTORE_MS = 1500

/** The phone layout: tab bar, sheets instead of dialogs, stacked tables. */
export const PHONE_QUERY = "(max-width: 760px)"
/**
 * A list with its reading pane beside it (DS-13). By width only: a change of height (an on-screen keyboard, a
 * resized window) must not swap the layout, which would drop the open item and what is typed in it. On a short
 * screen the two stay side by side and scroll with the page as one (the `short` variant, NL-1).
 */
export const SPLIT_QUERY = "(min-width: 1000px)"
/** A screen used by touch only, where focusing a field raises the on-screen keyboard (DS-8, MP-4). */
export const TOUCH_ONLY_QUERY = "(hover: none) and (pointer: coarse)"

/** Whether this is a touch-only screen; false where there is no window (tests, server rendering). */
export const touchOnly = () => typeof window !== "undefined" && window.matchMedia?.(TOUCH_ONLY_QUERY).matches === true

/** The open page reads its session clocks this often, and every few seconds while it warns (services/session-policy.ts). */
export const SESSION_POLL_MS = 30_000
export const SESSION_WARN_POLL_MS = 5_000
/** A clock that reached zero is asked about at most this often; a session read that takes longer is given up. */
export const SESSION_ASK_GAP_MS = 2_000
export const SESSION_TIMEOUT_MS = 10_000
/** Real input is reported to the server at most this often; the last input in a quiet spell is still sent. */
export const ACTIVITY_REPORT_MS = 30_000
/** Asks whether the person is still there this long before the idle timeout signs them out. */
export const IDLE_WARN_MS = 60_000
/** Says the session is about to reach its maximum length this long before. */
export const MAX_WARN_MS = 5 * 60_000

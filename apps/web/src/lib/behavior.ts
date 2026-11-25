export const DIM_AFTER_MS = 200
export const COPIED_MS = 1500
export const TIP_TAP_MS = 2500
export const TIP_TAP_CLICK_MS = 600
export const TOAST_MS = 4000
export const TOAST_FADE_MS = 300
export const TOAST_REST_MS = 1500
export const UNDO_MS = 10_000
export const DONE_MS = 3000
export const FAILED_MS = 2000
export const CONFIRM_FOCUS_MS = 100
export const SHEET_PULL_CLOSE_PX = 120
export const SHEET_SLIDE_MS = 200
export const AGO_TICK_MS = 30_000
export const SEARCH_PAUSE_MS = 300
export const LIST_WAIT_MS = 8000
export const ROW_HOLD_MOVE_PX = 3

export const ATTENTION_POLL_MS = 30_000
export const ATTENTION_TIMEOUT_MS = 20_000

export const SCROLL_RESTORE_MS = 1500

export const PHONE_QUERY = "(max-width: 760px)"
export const SPLIT_QUERY = "(min-width: 1000px)"
export const TOUCH_ONLY_QUERY = "(hover: none) and (pointer: coarse)"

export const touchOnly = () => typeof window !== "undefined" && window.matchMedia?.(TOUCH_ONLY_QUERY).matches === true

export const SESSION_POLL_MS = 30_000
export const SESSION_WARN_POLL_MS = 5_000
export const SESSION_ASK_GAP_MS = 2_000
export const SESSION_TIMEOUT_MS = 10_000
export const ACTIVITY_REPORT_MS = 30_000
export const IDLE_WARN_MS = 60_000
export const MAX_WARN_MS = 5 * 60_000

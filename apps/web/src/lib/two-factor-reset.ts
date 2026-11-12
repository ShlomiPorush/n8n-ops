/*
 * A two-factor reset under way in this tab. The Account page marks it before it turns two-factor off and then
 * loads /setup afresh, where the server's answer decides the step: the person sets up a new code and comes back to
 * Account, without the optional setup steps (Telegram, the backup destination) they once skipped.
 *
 * The mark lasts 15 minutes and is not taken away when /setup finds two-factor still on: turning it off may finish
 * on the server only after the page reloaded, and the setup that follows still skips those steps. It goes once the
 * new code is set up, once the reset was refused, and when the person signs out.
 */

const KEY = "n8n-ops.two-factor-reset"
const LASTS = 15 * 60_000

/** Marks a reset as started in this tab. */
export function markTwoFactorReset() {
  try {
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    // Without storage the setup after the reset shows its optional steps, which can be skipped.
  }
}

/** Whether a reset started in this tab in the last 15 minutes. */
export function twoFactorResetPending(now = Date.now()): boolean {
  try {
    const at = Number(sessionStorage.getItem(KEY))
    return at > 0 && now - at >= 0 && now - at < LASTS
  } catch {
    return false
  }
}

/** The reset is over: the new code is set up, or two-factor was not changed. */
export function clearTwoFactorReset() {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // Nothing to clear without storage.
  }
}

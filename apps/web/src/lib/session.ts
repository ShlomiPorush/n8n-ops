/*
 * The signed-in session as the page sees it (NL-18, SV-1). A request answered 401 on an open page means the
 * session ended: the unsaved-changes guard is switched off, so leaving does not ask, and the page goes to sign-in
 * with the address it was on, once. Signing out switches the guard off too, once it worked.
 */

let signedIn = false
let ending = false
let guardOff = false

/**
 * Sign-in, and back to this address afterwards: `/login?next=<path+query>`, plain `/login` from `/`. `ended` is
 * why the server ended the session (idle, max, lifetime), for the sign-in page to say.
 */
export function loginPath(pathname: string, search = "", ended?: string): string {
  const params = new URLSearchParams()
  if (ended) params.set("ended", ended)
  if (pathname !== "/") params.set("next", pathname + search)
  const query = params.toString()
  return query ? `/login?${query}` : "/login"
}

/** The signed-in area has loaded with a session: a 401 from now on means it ended. */
export function sessionStarted() {
  signedIn = true
  ending = false
  guardOff = false
}

/** Signing out worked: nothing asks about unsaved changes on the way out, and a 401 after it is expected. */
export function sessionClosed() {
  signedIn = false
  guardOff = true
}

/** Whether leaving with unsaved changes should ask; off once the session has ended or was closed. */
export function unsavedGuardOn() {
  return !guardOff
}

/**
 * A request was answered 401. On an open signed-in page this goes to sign-in, once, without asking, with the
 * reason when the server gave one (the session clocks under Settings > Sign-in security).
 */
export function sessionEnded(reason?: string) {
  if (!signedIn || ending || window.location.pathname.startsWith("/login")) return
  ending = true
  guardOff = true
  window.location.replace(loginPath(window.location.pathname, window.location.search, reason))
}

/** Whether the page is on its way to sign-in after the session ended; its errors are not worth a toast. */
export function sessionEnding() {
  return ending
}

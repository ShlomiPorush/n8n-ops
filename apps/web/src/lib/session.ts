let signedIn = false
let ending = false
let guardOff = false

export function loginPath(pathname: string, search = "", ended?: string): string {
  const params = new URLSearchParams()
  if (ended) params.set("ended", ended)
  if (pathname !== "/") params.set("next", pathname + search)
  const query = params.toString()
  return query ? `/login?${query}` : "/login"
}

export function sessionStarted() {
  signedIn = true
  ending = false
  guardOff = false
}

export function sessionClosed() {
  signedIn = false
  guardOff = true
}

export function unsavedGuardOn() {
  return !guardOff
}

export function sessionEnded(reason?: string) {
  if (!signedIn || ending || window.location.pathname.startsWith("/login")) return
  ending = true
  guardOff = true
  window.location.replace(loginPath(window.location.pathname, window.location.search, reason))
}

export function sessionEnding() {
  return ending
}

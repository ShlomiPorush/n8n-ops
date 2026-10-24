import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

afterEach(() => vi.unstubAllGlobals())

/** A fresh copy of the module, since it holds the session state of one page. */
const load = async () => {
  vi.resetModules()
  return import("./session.ts")
}

describe("loginPath", () => {
  it("comes back to the page and its query after signing in, and to the overview from /", async () => {
    const { loginPath } = await load()
    expect(loginPath("/settings/alerts", "?x=1")).toBe("/login?next=%2Fsettings%2Falerts%3Fx%3D1")
    expect(loginPath("/problems")).toBe("/login?next=%2Fproblems")
    expect(loginPath("/")).toBe("/login")
  })
})

describe("sessionEnded", () => {
  let replace: ReturnType<typeof vi.fn>
  const at = (pathname: string, search = "") => {
    replace = vi.fn()
    vi.stubGlobal("window", { location: { pathname, search, replace } })
  }
  beforeEach(() => at("/settings/alerts", "?tab=1"))

  it("does nothing before a signed-in page has loaded, such as on the login page itself", async () => {
    const session = await load()
    session.sessionEnded()
    expect(replace).not.toHaveBeenCalled()
    expect(session.unsavedGuardOn()).toBe(true)
  })

  it("goes to sign-in once, with the page to come back to, and stops asking about unsaved changes (NL-18)", async () => {
    const session = await load()
    session.sessionStarted()
    session.sessionEnded()
    session.sessionEnded()
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith("/login?next=%2Fsettings%2Falerts%3Ftab%3D1")
    expect(session.unsavedGuardOn()).toBe(false)
    expect(session.sessionEnding()).toBe(true)
  })

  it("stays on the login page and after a sign-out that worked", async () => {
    const session = await load()
    session.sessionStarted()
    at("/login", "?next=%2F")
    session.sessionEnded()
    expect(replace).not.toHaveBeenCalled()

    at("/instances")
    session.sessionClosed()
    expect(session.unsavedGuardOn()).toBe(false)
    session.sessionEnded()
    expect(replace).not.toHaveBeenCalled()
    // Signing in again turns the guard back on.
    session.sessionStarted()
    expect(session.unsavedGuardOn()).toBe(true)
  })
})

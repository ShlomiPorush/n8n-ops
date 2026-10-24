import { createMemoryRouter, type Location } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"
import { checkOutcome, formChanged, guardLeaves, leaveAsker, saveOutcome } from "./save-bar.tsx"

describe("formChanged", () => {
  const opened = {
    name: "NAS",
    retention: { daily: "7", weekly: "4" },
    credentials: { user: "backup", password: undefined },
    enabled: true,
  }

  it("is false for the form as it opened, also with spaces around a value or a cleared secret", () => {
    expect(formChanged(structuredClone(opened), opened)).toBe(false)
    expect(formChanged({ ...opened, name: " NAS " }, opened)).toBe(false)
    expect(formChanged({ ...opened, credentials: { user: "backup", password: "" } }, opened)).toBe(false)
  })

  it("sees a change in a nested field, a switch and a typed secret", () => {
    expect(formChanged({ ...opened, retention: { daily: "8", weekly: "4" } }, opened)).toBe(true)
    expect(formChanged({ ...opened, enabled: false }, opened)).toBe(true)
    expect(formChanged({ ...opened, credentials: { user: "backup", password: "s3cret" } }, opened)).toBe(true)
  })

  it("is false again when a field is changed back", () => {
    const changed = { ...opened, name: "NAS 2" }
    expect(formChanged(changed, opened)).toBe(true)
    expect(formChanged({ ...changed, name: "NAS" }, opened)).toBe(false)
  })

  it("sees a stored secret marked for removal (null) as a change, and Keep after Remove as none", () => {
    const removed = { ...opened, credentials: { user: "backup", password: null } }
    expect(formChanged(removed, opened)).toBe(true)
    expect(formChanged(opened, removed)).toBe(true)
    expect(formChanged(removed, structuredClone(removed))).toBe(false)
    expect(formChanged({ ...removed, credentials: { user: "backup", password: undefined } }, opened)).toBe(false)
  })
})

describe("leaveAsker", () => {
  /** A router on /settings with /instances before it, guarded like the save bar: every move to another page asks. */
  function setup() {
    const router = createMemoryRouter([{ path: "/instances" }, { path: "/settings" }], {
      initialEntries: ["/instances", "/settings"],
      initialIndex: 1,
    })
    const guard = ({ currentLocation, nextLocation }: { currentLocation: Location; nextLocation: Location }) =>
      currentLocation.pathname !== nextLocation.pathname
    const blocker = () => router.getBlocker("leave", guard)
    blocker()
    // Like the confirm: a second question replaces the first, which counts as cancelled.
    const open: ((ok: boolean) => void)[] = []
    const ask = vi.fn(
      (signal: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          open.at(-1)?.(false)
          open.push(resolve)
          signal.addEventListener("abort", () => resolve(false))
        }),
    )
    const asker = leaveAsker(ask, blocker)
    router.subscribe((state) => asker.update(state.blockers.get("leave") ?? blocker()))
    const answer = async (ok: boolean) => {
      open.at(-1)?.(ok)
      await settle()
    }
    return { router, blocker, ask, asker, answer }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve))

  it("keeps one question when Back is pressed while it is open, and Back counts as Stay (SV-1)", async () => {
    const { router, blocker, ask, answer } = setup()
    await router.navigate(-1)
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(blocker().state).toBe("blocked")

    // Back again while the question is open: undone by the router, and the question closes as Stay.
    await router.navigate(-1)
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(blocker().state).toBe("unblocked")
    expect(router.state.location.pathname).toBe("/settings")

    // The next Back asks again, and Leave goes back without an invalid blocker state.
    await router.navigate(-1)
    await settle()
    expect(ask).toHaveBeenCalledTimes(2)
    await answer(true)
    expect(router.state.location.pathname).toBe("/instances")
  })

  it("does nothing with an answer once a finished navigation has cleared the block", async () => {
    const { router, blocker, ask, answer } = setup()
    await router.navigate("/instances")
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    // A move on the same page is not blocked; when it is done the router clears every block.
    await router.navigate("/settings?section=email")
    await settle()
    expect(blocker().state).toBe("unblocked")
    await answer(true)
    expect(router.state.location.pathname).toBe("/settings")
  })

  it("closes the question without an answer when the guard goes away", async () => {
    const { router, blocker, asker, answer } = setup()
    await router.navigate("/instances")
    await settle()
    asker.stop()
    await answer(true)
    expect(blocker().state).toBe("blocked")
    expect(router.state.location.pathname).toBe("/settings")
  })
})

/** A question like the confirm's: a second one replaces the first, which counts as cancelled; abort cancels. */
function questions() {
  const open: ((ok: boolean) => void)[] = []
  const ask = vi.fn(
    (signal: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        open.at(-1)?.(false)
        open.push(resolve)
        signal.addEventListener("abort", () => resolve(false))
      }),
  )
  return { ask, answer: (ok: boolean) => open.at(-1)?.(ok) }
}
const settle = () => new Promise((resolve) => setTimeout(resolve))
/** Blocks a move to another page, as the save bar does with unsaved changes. */
const toAnotherPage = ({ currentLocation, nextLocation }: { currentLocation: Location; nextLocation: Location }) =>
  currentLocation.pathname !== nextLocation.pathname

describe("guardLeaves", () => {
  function setup() {
    const router = createMemoryRouter([{ path: "/instances" }, { path: "/settings" }], {
      initialEntries: ["/instances", "/settings"],
      initialIndex: 1,
    })
    const { ask, answer } = questions()
    const guard = guardLeaves(router, toAnotherPage, ask)
    const answerAndSettle = async (ok: boolean) => {
      answer(ok)
      await settle()
    }
    return { router, ask, guard, answer: answerAndSettle }
  }

  it("acts on the router's block as it is when the answer comes, not as it was asked", async () => {
    const { router, ask, answer } = setup()
    await router.navigate("/instances")
    expect(ask).toHaveBeenCalledTimes(1)
    // A move on the same page finishes while the question is open: it clears the block and closes the question.
    await router.navigate("/settings?section=email")
    await settle()
    // Leave now neither proceeds the cleared move nor fails on it ("Invalid blocker state transition").
    await answer(true)
    expect(router.state.location.pathname).toBe("/settings")
    expect(router.state.location.search).toBe("?section=email")
  })

  it("asks once per block however often the router reports its state, and Leave goes", async () => {
    const { router, ask, answer } = setup()
    await router.navigate("/instances")
    // Other news from the router, such as a fetcher, is not a new block.
    router.revalidate()
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    await answer(true)
    expect(router.state.location.pathname).toBe("/instances")
  })

  it("asks Log out through the same one question: Back while it is open counts as Stay and is undone (SV-1)", async () => {
    const { router, ask, guard, answer } = setup()
    const logOut = guard.confirm()
    expect(ask).toHaveBeenCalledTimes(1)
    // Back is blocked and undone by the router; it opens no second question and closes this one as Stay.
    await router.navigate(-1)
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(await logOut).toBe(false)
    expect(router.state.location.pathname).toBe("/settings")
    expect([...router.state.blockers.values()].every((b) => b.state === "unblocked")).toBe(true)
    // The next Back asks again, and Leave goes back.
    await router.navigate(-1)
    await settle()
    expect(ask).toHaveBeenCalledTimes(2)
    await answer(true)
    expect(router.state.location.pathname).toBe("/instances")
  })

  it("closes the Log out question without acting when a navigation happens anyway", async () => {
    const { router, guard, answer } = setup()
    const logOut = guard.confirm()
    // Not blocked: the same page with another section.
    await router.navigate("/settings?section=email")
    await answer(true)
    expect(await logOut).toBe(false)
  })

  it("goes on with Log out when it is answered Leave, and asks no second question while one is open", async () => {
    const { router, ask, guard, answer } = setup()
    await router.navigate("/instances")
    expect(await guard.confirm()).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
    await answer(false)
    const logOut = guard.confirm()
    await answer(true)
    expect(await logOut).toBe(true)
  })

  it("forgets the router's block when it stops", async () => {
    const { router, ask, guard } = setup()
    guard.stop()
    await router.navigate("/instances")
    expect(ask).not.toHaveBeenCalled()
    expect(router.state.location.pathname).toBe("/instances")
  })
})

/**
 * Just enough of a browser for the router's own history: entries with their address and state (where the router
 * keeps its count, `idx`), pushState, replaceState, and go/back with a later popstate. `go(0)` is a reload.
 */
function fakeBrowser(start: string) {
  const origin = "http://localhost"
  const entries: { url: URL; state: Record<string, unknown> | null }[] = [{ url: new URL(start, origin), state: null }]
  let index = 0
  let reloads = 0
  const listeners = new Set<() => void>()
  const at = () => entries[index] as (typeof entries)[number]
  const go = (delta: number) => {
    if (delta === 0) {
      reloads += 1
      return
    }
    setTimeout(() => {
      if (!entries[index + delta]) return
      index += delta
      for (const listener of [...listeners]) listener()
    })
  }
  const window = {
    location: {
      origin,
      get href() {
        return at().url.href
      },
      get pathname() {
        return at().url.pathname
      },
      get search() {
        return at().url.search
      },
      get hash() {
        return at().url.hash
      },
    },
    addEventListener: (type: string, listener: () => void) => type === "popstate" && listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    history: {
      get state() {
        return at().state
      },
      pushState(state: Record<string, unknown>, _: string, url?: string) {
        entries.splice(index + 1, entries.length, { url: new URL(url ?? at().url.href, at().url), state })
        index += 1
      },
      replaceState(state: Record<string, unknown>, _: string, url?: string) {
        entries[index] = { url: new URL(url ?? at().url.href, at().url), state }
      },
      go,
      back: () => go(-1),
    },
  }
  return {
    window,
    get reloads() {
      return reloads
    },
  }
}

describe("a page opened from a dialog", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("Back from it with unsaved changes asks, Stay keeps it without a reload, Leave goes to the page before (DS-10, SV-1)", async () => {
    // Fresh copies: the overlays and their Back entries live in module state.
    vi.resetModules()
    const { createBrowserRouter } = await import("react-router")
    const overlays = await import("@/lib/overlay-history")
    const saveBar = await import("./save-bar.tsx")
    const browser = fakeBrowser("/instances/a")
    vi.stubGlobal("window", browser.window)
    const router = createBrowserRouter([{ path: "/instances/:id" }], {
      window: browser.window as unknown as Window,
    })
    await settle()

    // Unsaved changes on the new page only: the move from the dialog is not asked about.
    let unsaved = false
    const guard = (args: { currentLocation: Location; nextLocation: Location }) => unsaved && toAnotherPage(args)
    const blocker = () => router.getBlocker("leave", guard)
    blocker()
    const { ask, answer } = questions()
    const asker = saveBar.leaveAsker(ask, blocker)
    router.subscribe((state) => asker.update(state.blockers.get("leave") ?? blocker()))

    // Add instance: the dialog holds its Back entry, and the new instance's page takes it.
    const release = overlays.holdOverlayEntry(() => {})
    await settle()
    expect(browser.window.history.state?.overlay).toBeDefined()
    const replace = overlays.leaveOverlays()
    await router.navigate("/instances/b", { replace })
    release()
    await settle()
    expect(router.state.location.pathname).toBe("/instances/b")
    unsaved = true

    // Back asks; the router undoes it by stepping forward again, which must not be a reload.
    browser.window.history.back()
    await settle()
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    answer(false)
    await settle()
    expect(browser.reloads).toBe(0)
    expect(router.state.location.pathname).toBe("/instances/b")
    expect(browser.window.location.pathname).toBe("/instances/b")

    // Back again, and Leave goes to the page the dialog was opened on.
    browser.window.history.back()
    await settle()
    await settle()
    expect(ask).toHaveBeenCalledTimes(2)
    answer(true)
    await settle()
    await settle()
    expect(browser.reloads).toBe(0)
    expect(router.state.location.pathname).toBe("/instances/a")
    expect(browser.window.location.pathname).toBe("/instances/a")
  })
})

describe("saveOutcome", () => {
  const general = { label: "the General settings", saved: "Settings saved" }
  const alerts = { label: "the Alerts settings", saved: "Settings saved" }

  it("says nothing when nothing was saved", () => {
    expect(saveOutcome([], [])).toBeNull()
  })

  it("names one area by its own toast and several by their labels", () => {
    expect(saveOutcome([general], [])).toEqual({ tone: "success", text: "Settings saved" })
    expect(saveOutcome([general, alerts], [])).toEqual({
      tone: "success",
      text: "Saved the General settings and the Alerts settings",
    })
  })

  it("never covers a failure with a success: the failed area is named with its reason (SV-3)", () => {
    expect(saveOutcome([general], [{ label: "the Alerts settings", detail: "retryMin: too big" }])).toEqual({
      tone: "error",
      text: "Saved the General settings. Could not save the Alerts settings: retryMin: too big",
    })
    expect(
      saveOutcome(
        [],
        [
          { label: "the overrides", detail: "Not found." },
          { label: "agent access", detail: "Something went wrong on the server." },
        ],
      ),
    ).toEqual({
      tone: "error",
      text: "Could not save the overrides (Not found.) and agent access (Something went wrong on the server.)",
    })
  })
})

describe("checkOutcome", () => {
  it("says nothing when every field passed", () => {
    expect(checkOutcome([])).toBeNull()
  })

  it("names one failed field with its problem, and several by the first (SV-1)", () => {
    const recipients = { label: "Recipients", problem: '"bob" is not an email address' }
    const time = { label: "Daily report time", problem: "use a 24-hour time as HH:MM, for example 07:30" }
    expect(checkOutcome([recipients])).toBe('Recipients: "bob" is not an email address')
    expect(checkOutcome([time, recipients])).toBe("2 fields need a valid value, starting with Daily report time")
  })
})

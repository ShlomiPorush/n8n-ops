import { createMemoryRouter, type Location } from "react-router"
import { describe, expect, it, vi } from "vitest"
import { formChanged, leaveAsker, saveOutcome } from "./save-bar.tsx"

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

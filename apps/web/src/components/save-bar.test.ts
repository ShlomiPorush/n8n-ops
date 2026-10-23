import { describe, expect, it } from "vitest"
import { formChanged, saveOutcome } from "./save-bar.tsx"

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

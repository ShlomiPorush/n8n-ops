import { settingLabel } from "@n8n-ops/shared"
import { describe, expect, it } from "vitest"
import { createTestRuns } from "@/lib/test-run"
import {
  changeCount,
  defaultText,
  differsFromDefault,
  type FieldDef,
  fieldProblem,
  forms,
  testDraft,
  testIdentity,
  testMissing,
  toForm,
  withPending,
} from "./settings.tsx"

const field = (section: string, name: string) => forms[section]?.fields.find((f) => f.name === name) as FieldDef

describe("Settings fields", () => {
  it("have the labels the server names them by, so a refused field reads the same in both", () => {
    for (const [section, def] of Object.entries(forms))
      for (const f of def.fields) expect(`${section}.${f.label}`).toBe(`${section}.${settingLabel(section, f.name)}`)
  })

  it("load a public URL that comes from the environment as empty, so no save stores it (FS-6)", () => {
    const data = {
      publicUrl: "https://ops.example.com",
      timezone: "UTC",
      design: "regular",
      meta: { env: { publicUrl: { variable: "N8N_OPS_PUBLIC_URL", value: "https://ops.example.com", inUse: true } } },
    }
    expect(toForm(forms.general as { fields: FieldDef[] }, data).publicUrl).toBe("")
    const typed = { ...data, publicUrl: "https://typed.example.com" }
    typed.meta.env.publicUrl.inUse = false
    expect(toForm(forms.general as { fields: FieldDef[] }, typed).publicUrl).toBe("https://typed.example.com")
  })

  it("are checked in words before a save (SV-1, SV-12)", () => {
    expect(fieldProblem("email", field("email", "recipients"), ["ops@example.com", "bob"])).toBe(
      '"bob" is not an email address',
    )
    expect(fieldProblem("email", field("email", "dailyTime"), "7:30")).toMatch(/HH:MM/)
    expect(fieldProblem("alerts", field("alerts", "retryMin"), "99", { retryMin: { min: 1, max: 60 } })).toBe(
      "use a whole number from 1 to 60",
    )
    expect(fieldProblem("access", field("access", "telegramApprovers"), ["@ops_lead", "123"])).toBeNull()
    expect(fieldProblem("telegram", field("telegram", "chatId"), "my chat")).toMatch(/chat's number/)
    expect(fieldProblem("general", field("general", "design"), "compact")).toBeNull()
  })

  it("count text typed in a list's Add field as a change before it is a chip, and save it (SV-1)", () => {
    const def = forms.email as { fields: FieldDef[] }
    const loaded = { recipients: ["ops@example.com"], smtpHost: "mail.example.com", smtpPassword: undefined }
    expect(changeCount(def, withPending(loaded, {}), loaded)).toBe(0)
    const typed = withPending(loaded, { recipients: " dev@example.com " })
    expect(typed.recipients).toEqual(["ops@example.com", "dev@example.com"])
    expect(changeCount(def, typed, loaded)).toBe(1)
    // Text that adds nothing, blank or a value already in the list, is no change.
    expect(changeCount(def, withPending(loaded, { recipients: "  " }), loaded)).toBe(0)
    expect(changeCount(def, withPending(loaded, { recipients: "OPS@example.com" }), loaded)).toBe(0)
  })

  it("are Changed against their default as their type compares, and Reset names it (FS-6)", () => {
    expect(differsFromDefault(field("alerts", "retryMin"), "05", 5)).toBe(false)
    expect(differsFromDefault(field("alerts", "retryMin"), "6", 5)).toBe(true)
    expect(differsFromDefault(field("alerts", "health"), false, true)).toBe(true)
    expect(differsFromDefault(field("general", "timezone"), "", "UTC")).toBe(false)
    expect(defaultText(field("alerts", "health"), true)).toBe("On")
    expect(defaultText(field("email", "weeklyDay"), 0)).toBe("Sunday")
    expect(defaultText(field("general", "design"), "regular")).toBe("Regular")
    expect(defaultText(field("alerts", "retryMin"), 5)).toBe("5")
  })
})

describe("a connection test with the values on screen (FS-19)", () => {
  const values = {
    recipients: ["ops@example.com"],
    from: " ",
    smtpHost: " mail.example.com ",
    smtpPort: "2525",
    smtpSecure: false,
    smtpUser: "reports",
    smtpPassword: undefined,
  }

  it("sends the unsaved values, and a secret only when typed or being removed", () => {
    expect(testDraft("email", values)).toEqual({
      recipients: ["ops@example.com"],
      from: "",
      smtpHost: "mail.example.com",
      smtpPort: 2525,
      smtpSecure: false,
      smtpUser: "reports",
    })
    expect(testDraft("email", { ...values, smtpPassword: "" })).not.toHaveProperty("smtpPassword")
    expect(testDraft("email", { ...values, smtpPassword: "typed" })).toMatchObject({ smtpPassword: "typed" })
    expect(testDraft("telegram", { chatId: " 4242 ", botToken: null })).toEqual({ chatId: "4242", botToken: null })
  })

  it("keeps no result across a saved secret, though the stored one is not among the values (SV-5)", () => {
    const runs = createTestRuns()
    // The stored password is tested, then replaced and saved: the field is empty again, as before.
    const tested = runs.start(testIdentity("email", values, 0))
    runs.settle(tested, { ok: true }, 1000)
    expect(testIdentity("email", values, 0)).toBe(testIdentity("email", { ...values }, 0))
    expect(runs.view(testIdentity("email", values, 0)).kind).toBe("accepted")
    expect(runs.view(testIdentity("email", values, 1))).toEqual({ kind: "changed", at: 1000 })
    // A test still on its way when the secret is saved answers for the one before.
    const late = runs.start(testIdentity("email", { ...values, smtpSecure: true }, 1))
    runs.settle(late, { ok: true }, 2000)
    expect(runs.view(testIdentity("email", { ...values, smtpSecure: true }, 2)).kind).toBe("changed")
  })

  it("says what it still needs on screen", () => {
    expect(testMissing("email", testDraft("email", values), {})).toBeNull()
    expect(testMissing("email", testDraft("email", { ...values, recipients: [] }), {})).toBe(
      "the SMTP server and a recipient",
    )
    const telegram = (v: Record<string, unknown>, d: Record<string, unknown>) =>
      testMissing("telegram", testDraft("telegram", v), d)
    expect(telegram({ chatId: "4242" }, { botTokenSet: true })).toBeNull()
    expect(telegram({ chatId: "4242", botToken: null }, { botTokenSet: true })).toBe("the bot token and the chat ID")
    expect(telegram({ chatId: "4242", botToken: "123:abc" }, {})).toBeNull()
    expect(telegram({ chatId: "" }, { botTokenSet: true })).toBe("the bot token and the chat ID")
  })
})

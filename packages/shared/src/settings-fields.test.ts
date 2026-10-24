import { describe, expect, it } from "vitest"
import {
  isEmailAddress,
  isFromAddress,
  isTelegramChat,
  isTelegramUser,
  numberProblem,
  settingLabel,
  splitEntries,
  valueProblem,
} from "./settings-fields.ts"

describe("entries typed or pasted into a list", () => {
  it("are split at commas, semicolons, spaces and line breaks, and trimmed", () => {
    expect(splitEntries(" a@example.com, b@example.com;c@example.com\nd@example.com  e@example.com ")).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
      "d@example.com",
      "e@example.com",
    ])
    expect(splitEntries(" , ;")).toEqual([])
  })
})

describe("email addresses", () => {
  it("takes ordinary addresses", () => {
    for (const a of ["operator@example.com", "first.last+ops@mail.example.co.uk", "n8n-ops@example.com"])
      expect(isEmailAddress(a)).toBe(true)
  })

  it("refuses a name alone, a domain without a dot and other near misses (SV-12)", () => {
    for (const a of ["bob", "bob@exmaple", "@example.com", "bob@", "bob@@example.com", "bob@example..com", "a b@x.com"])
      expect(isEmailAddress(a)).toBe(false)
  })

  it("takes a From address with a name", () => {
    expect(isFromAddress("n8n-ops <ops@example.com>")).toBe(true)
    expect(isFromAddress("ops@example.com")).toBe(true)
    expect(isFromAddress("n8n-ops <ops>")).toBe(false)
  })
})

describe("Telegram", () => {
  it("takes a user ID or an @username as an approver, as the approver check compares them", () => {
    expect(isTelegramUser("123456789")).toBe(true)
    expect(isTelegramUser("@ops_lead")).toBe(true)
    expect(isTelegramUser("ops_lead")).toBe(false)
    expect(isTelegramUser("-100123")).toBe(false)
  })

  it("takes a negative group ID or a channel name as the chat", () => {
    expect(isTelegramChat("-1001234567890")).toBe(true)
    expect(isTelegramChat("4242")).toBe(true)
    expect(isTelegramChat("@ops_channel")).toBe(true)
    expect(isTelegramChat("my chat")).toBe(false)
  })
})

describe("problems in words", () => {
  it("names the refused entries of a list", () => {
    expect(valueProblem("emails", ["ok@example.com", "bob"])).toBe('"bob" is not an email address')
    expect(valueProblem("emails", ["bob", "eve@x", "ok@example.com"])).toBe('"bob" and "eve@x" are not email addresses')
    expect(valueProblem("telegram-users", ["alice"])).toBe('"alice" is not a Telegram user ID or @username')
    expect(valueProblem("emails", [])).toBeNull()
  })

  it("lets an empty single value through, as not set, but not an empty time", () => {
    expect(valueProblem("web-address", "")).toBeNull()
    expect(valueProblem("web-address", "ops.example.com")).toMatch(/^use a full address/)
    expect(valueProblem("web-address", "https://ops.example.com")).toBeNull()
    expect(valueProblem("time", "")).toMatch(/HH:MM/)
    expect(valueProblem("time", "7:30")).toMatch(/HH:MM/)
    expect(valueProblem("time", "07:30")).toBeNull()
  })

  it("says the range of a number", () => {
    expect(numberProblem("99", { min: 1, max: 60 })).toBe("use a whole number from 1 to 60")
    expect(numberProblem("", { min: 1 })).toBe("use a whole number of at least 1")
    expect(numberProblem("2.5", {})).toBe("use a whole number")
    expect(numberProblem(" 30 ", { min: 1, max: 60 })).toBeNull()
  })

  it("names a field by its label", () => {
    expect(settingLabel("email", "dailyTime")).toBe("Daily report time")
    expect(settingLabel("email", "unknown")).toBe("unknown")
  })
})

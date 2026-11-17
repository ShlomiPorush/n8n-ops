import { describe, expect, it } from "vitest"
import { directionMark, RLM, readsRightToLeft } from "./text-direction.ts"

describe("the direction of free text", () => {
  it("is right to left when most of its letters are Hebrew or Arabic, also when it opens with English", () => {
    expect(readsRightToLeft("השבתת משתמש, קריאה בלבד")).toBe(true)
    expect(readsRightToLeft("Phase 0 של ה-CRM: workflow זמני אחד שמחזיר ספירות")).toBe(true)
    // Long English terms count as one word each.
    expect(readsRightToLeft("בלי שינוי ב-workflows או credentials")).toBe(true)
    expect(readsRightToLeft("قراءة سير العمل فقط")).toBe(true)
  })

  it("is left to right for English, for English with a Hebrew word, and with no letters at all", () => {
    expect(readsRightToLeft("Read the Sync workflow")).toBe(false)
    expect(readsRightToLeft("Read the workflow named סנכרון and fix the Set node")).toBe(false)
    expect(readsRightToLeft("123 - 456 !")).toBe(false)
    expect(readsRightToLeft("")).toBe(false)
  })

  it("marks only right-to-left text", () => {
    expect(directionMark("Phase 0 של ה-CRM לפי התוכנית")).toBe(RLM)
    expect(directionMark("Read the Sync workflow")).toBe("")
  })
})

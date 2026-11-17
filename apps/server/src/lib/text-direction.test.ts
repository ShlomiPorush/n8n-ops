import { describe, expect, it } from "vitest"
import { directionMark, readsRightToLeft } from "./text-direction.ts"

describe("the direction of free text", () => {
  it("is right to left when most of its words are Hebrew or Arabic, also when it opens with English", () => {
    expect(readsRightToLeft("השבתת משתמש, קריאה בלבד")).toBe(true)
    expect(readsRightToLeft("Phase 0 של ה-CRM: workflow זמני אחד שמחזיר ספירות")).toBe(true)
    expect(readsRightToLeft("قراءة سير العمل فقط")).toBe(true)
    // Long English terms count as one word each.
    expect(readsRightToLeft("בלי שינוי ב-workflows או credentials")).toBe(true)
  })

  it("is left to right for English, for English with a Hebrew word, and with no letters at all", () => {
    expect(readsRightToLeft("Read the Sync workflow")).toBe(false)
    expect(readsRightToLeft("סנכרון: Read the workflow and list its nodes.")).toBe(false)
    expect(readsRightToLeft("123 - 456 !")).toBe(false)
    expect(readsRightToLeft("")).toBe(false)
  })

  it("counts a word with Hebrew points or Arabic vowels once", () => {
    expect(readsRightToLeft("Read only workflow דּוּגְמָה.")).toBe(false)
    expect(readsRightToLeft("Read שָׁלוֹם עוֹלָם")).toBe(true)
    expect(readsRightToLeft("Read only workflow كَتَبَ")).toBe(false)
  })

  it("is right to left in the other right-to-left scripts too", () => {
    expect(readsRightToLeft("CRM 𐴀𐴁𐴂 𐴃𐴄")).toBe(true)
    expect(readsRightToLeft("CRM 𐺀𐺁 𐺂𐺃")).toBe(true)
  })

  it("marks right-to-left text right to left, and every other text left to right", () => {
    expect(directionMark("Phase 0 של ה-CRM לפי התוכנית")).toBe("‏")
    expect(directionMark("סנכרון: Read the workflow and list its nodes.")).toBe("‎")
    expect(directionMark("")).toBe("‎")
  })
})

import { describe, expect, it } from "vitest"
import { directionMark, readsRightToLeft } from "./text-direction.ts"

const disable =
  "\u{5D4}\u{5E9}\u{5D1}\u{5EA}\u{5EA} \u{5DE}\u{5E9}\u{5EA}\u{5DE}\u{5E9}, \u{5E7}\u{5E8}\u{5D9}\u{5D0}\u{5D4} \u{5D1}\u{5DC}\u{5D1}\u{5D3}"
const phase =
  "Phase 0 \u{5E9}\u{5DC} \u{5D4}-CRM: workflow \u{5D6}\u{5DE}\u{5E0}\u{5D9} \u{5D0}\u{5D7}\u{5D3} \u{5E9}\u{5DE}\u{5D7}\u{5D6}\u{5D9}\u{5E8} \u{5E1}\u{5E4}\u{5D9}\u{5E8}\u{5D5}\u{5EA}"
const terms = "\u{5D1}\u{5DC}\u{5D9} \u{5E9}\u{5D9}\u{5E0}\u{5D5}\u{5D9} \u{5D1}-workflows \u{5D0}\u{5D5} credentials"
const sync = "\u{5E1}\u{5E0}\u{5DB}\u{5E8}\u{5D5}\u{5DF}: Read the workflow and list its nodes."

describe("the direction of free text", () => {
  it("is right to left when most of its words are Hebrew or Arabic, also when it opens with English", () => {
    expect(readsRightToLeft(disable)).toBe(true)
    expect(readsRightToLeft(phase)).toBe(true)
    expect(readsRightToLeft("قراءة سير العمل فقط")).toBe(true)
    expect(readsRightToLeft(terms)).toBe(true)
  })

  it("is left to right for English, for English with a Hebrew word, and with no letters at all", () => {
    expect(readsRightToLeft("Read the Sync workflow")).toBe(false)
    expect(readsRightToLeft(sync)).toBe(false)
    expect(readsRightToLeft("123 - 456 !")).toBe(false)
    expect(readsRightToLeft("")).toBe(false)
  })

  it("counts a word with Hebrew points, Arabic vowels or a Persian zero-width non-joiner once", () => {
    expect(
      readsRightToLeft("Read only workflow \u{5D3}\u{5BC}\u{5D5}\u{5BC}\u{5D2}\u{5B0}\u{5DE}\u{5B8}\u{5D4}."),
    ).toBe(false)
    expect(
      readsRightToLeft(
        "Read \u{5E9}\u{5B8}\u{5C1}\u{5DC}\u{5D5}\u{5B9}\u{5DD} \u{5E2}\u{5D5}\u{5B9}\u{5DC}\u{5B8}\u{5DD}",
      ),
    ).toBe(true)
    expect(readsRightToLeft("Read only workflow كَتَبَ")).toBe(false)
    expect(readsRightToLeft("Please read this workflow می\u{200C}خواهم نمی\u{200C}دانم کتاب\u{200C}ها")).toBe(false)
  })

  it("is right to left in the other right-to-left scripts too", () => {
    expect(readsRightToLeft("CRM \u{10D00}\u{10D01}\u{10D02} \u{10D03}\u{10D04}")).toBe(true)
    expect(readsRightToLeft("CRM \u{10E80}\u{10E81} \u{10E82}\u{10E83}")).toBe(true)
    expect(readsRightToLeft("CRM \u{10D50}\u{10D51} \u{10D52}\u{10D53}")).toBe(true)
  })

  it("marks right-to-left text right to left, and every other text left to right", () => {
    expect(directionMark(phase)).toBe("\u{200F}")
    expect(directionMark(sync)).toBe("\u{200E}")
    expect(directionMark("")).toBe("\u{200E}")
  })
})

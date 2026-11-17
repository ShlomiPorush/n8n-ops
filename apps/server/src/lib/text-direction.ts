/** Letters of the scripts written right to left. */
const RIGHT_TO_LEFT =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u
const WORD = /\p{L}+/gu

/**
 * Whether free text (what an agent wrote) reads right to left: more of its words are in a right-to-left script than
 * in any other. Counting every word, not taking the first letter, keeps a Hebrew sentence that opens with an English
 * term ("Phase 0 של ה-CRM") right to left; counting words, not letters, keeps long English terms from outweighing it.
 */
export function readsRightToLeft(text: string) {
  let balance = 0
  for (const [word] of text.matchAll(WORD)) balance += RIGHT_TO_LEFT.test(word) ? 1 : -1
  return balance > 0
}

/** The right-to-left mark: a paragraph whose first strong character it is reads right to left. */
export const RLM = "‏"

/** A right-to-left mark for text that reads right to left, so a client that takes the first letter shows it so. */
export const directionMark = (text: string) => (readsRightToLeft(text) ? RLM : "")

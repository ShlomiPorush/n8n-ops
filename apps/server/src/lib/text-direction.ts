/** Letters of the scripts written right to left. */
const RIGHT_TO_LEFT =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Yezidi}]/u
/** A word: letters with the marks on them, so a word with Hebrew points or Arabic vowels counts once. */
const WORD = /\p{L}[\p{L}\p{M}]*/gu

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

/**
 * The direction mark for free text: right to left (U+200F) or left to right (U+200E), as `readsRightToLeft` decides.
 * A client that takes a paragraph's direction from its first letter then reads it that way, whichever word comes
 * first.
 */
export const directionMark = (text: string) => (readsRightToLeft(text) ? "‏" : "‎")

const RIGHT_TO_LEFT =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Yezidi}\u{10D40}-\u{10D8F}]/u
const WORD = /\p{L}[\p{L}\p{M}\u{200C}\u{200D}]*/gu

export function readsRightToLeft(text: string) {
  let balance = 0
  for (const [word] of text.matchAll(WORD)) balance += RIGHT_TO_LEFT.test(word) ? 1 : -1
  return balance > 0
}

export const directionMark = (text: string) => (readsRightToLeft(text) ? "\u{200F}" : "\u{200E}")

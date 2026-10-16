import { createCn } from "cn/config"

/**
 * clsx + tailwind-merge from the cn package, taught the design tokens in index.css. Without this a size
 * like text-figure next to a colour like text-fail is taken for a second colour and dropped.
 */
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [{ text: ["h1", "figure", "title", "h2", "head", "body", "ctl", "small", "meta", "input-touch"] }],
      "font-weight": [{ font: ["title", "figure", "heavy"] }],
      shadow: [{ shadow: ["float", "modal", "knob"] }],
      rounded: [{ rounded: ["tag", "sheet"] }],
    },
  },
})

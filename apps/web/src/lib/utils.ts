import { createCn } from "cn/config"

/**
 * clsx + tailwind-merge from the cn package, taught the design tokens in index.css. Without this a size
 * like text-figure next to a colour like text-fail is taken for a second colour and dropped.
 */
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: ["h1", "figure", "title", "h2", "head", "body", "ctl", "small", "meta", "code", "none", "input-touch"],
        },
      ],
      "font-weight": [{ font: ["title", "figure", "heavy"] }],
      tracking: [{ tracking: ["caps"] }],
      shadow: [{ shadow: ["card", "float", "modal", "knob", "selected", "tab", "halo"] }],
      rounded: [{ rounded: ["kbd", "mark", "tag", "option", "sheet", "pop", "drawer"] }],
    },
  },
})

import { createCn } from "cn/config"

export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: ["h1", "figure", "title", "h2", "head", "body", "ctl", "small", "meta", "none", "input-touch"],
        },
      ],
      "font-weight": [{ font: ["title", "figure", "heavy"] }],
      tracking: [{ tracking: ["caps"] }],
      shadow: [{ shadow: ["card", "float", "modal", "knob", "selected", "tab", "halo", "rule"] }],
      rounded: [{ rounded: ["kbd", "mark", "tag", "option", "sheet", "pop", "drawer"] }],
    },
  },
})

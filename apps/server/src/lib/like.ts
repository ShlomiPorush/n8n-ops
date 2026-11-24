export const likeContains = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`

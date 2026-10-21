/**
 * A LIKE/ILIKE pattern that matches `text` anywhere, read literally. Backslash is PostgreSQL's
 * default escape character, so it is escaped along with the wildcards.
 */
export const likeContains = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`

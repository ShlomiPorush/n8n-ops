import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Hono } from "hono"
import type { Env } from "../http/types.ts"

/** The skill's files, in the layout of the folder an agent installs, and how each is served. */
const FILES: Record<string, string> = {
  "SKILL.md": "text/markdown; charset=utf-8",
  "scripts/n8n-ops": "text/plain; charset=utf-8",
  "scripts/n8n-ops.mjs": "text/javascript; charset=utf-8",
  "scripts/n8n-ops.ps1": "text/plain; charset=utf-8",
  "scripts/n8n-ops.sh": "text/plain; charset=utf-8",
}
const PLACEHOLDER = /__N8N_OPS_URL__/g

/** Whether agents may fetch the skill from this address: https, or http to this computer (development). */
export function servesSkill(issuer: string) {
  const url = new URL(issuer)
  return url.protocol === "https:" || ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
}

function installNote(base: string) {
  const list = Object.keys(FILES)
    .map((f) => `- ${base}/connect/skill/${f} → n8n-ops/${f}`)
    .join("\n")
  return `# Install the n8n-ops skill

Download these files into a folder named \`n8n-ops\` in your personal skills folder (Claude Code:
\`~/.claude/skills/\`, or \`$CLAUDE_CONFIG_DIR/skills/\` when it is set; Codex: \`~/.codex/skills/\`):

${list}

On Linux and macOS, make \`scripts/n8n-ops\` and \`scripts/n8n-ops.sh\` executable (\`chmod +x\`).

Then read \`n8n-ops/SKILL.md\` and connect: run \`n8n-ops connect\`, show the person the link and the code it
prints, and run \`n8n-ops connect --wait\` until it answers \`connected\`.
`
}

/**
 * The skill for agents that run commands, served by n8n-ops itself with its public URL filled in, so the person
 * only tells the agent where it is. Public (the files hold no secret), never cached, and only from an https
 * address: an agent runs what it downloads here.
 */
export function skillRoutes(issuer: () => Promise<string | null>, skillDir: string | undefined) {
  const app = new Hono<Env>()
  const cache = new Map<string, string>()
  const read = (file: string) => {
    if (!skillDir) return null
    let text = cache.get(file)
    if (text === undefined) {
      try {
        text = readFileSync(join(skillDir, file), "utf8")
      } catch {
        return null
      }
      cache.set(file, text)
    }
    return text
  }
  const headers = (type: string) => ({
    "Content-Type": type,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  })

  app.get("/connect/skill/*", async (c) => {
    const base = await issuer()
    if (!base || !servesSkill(base))
      return c.json(
        {
          error: "not_configured",
          message: "Agents install the skill from an https address. Set an https public URL in Settings → General.",
        },
        404,
      )
    const file = new URL(c.req.url).pathname.slice("/connect/skill/".length)
    if (file === "") {
      if (!read("SKILL.md")) return c.json({ error: "not_found", message: "This build has no agent skill." }, 404)
      return c.body(installNote(base), 200, headers("text/markdown; charset=utf-8"))
    }
    const type = FILES[file]
    const text = type ? read(file) : null
    if (!type || text === null) return c.json({ error: "not_found" }, 404)
    return c.body(text.replace(PLACEHOLDER, base), 200, headers(type))
  })
  return app
}

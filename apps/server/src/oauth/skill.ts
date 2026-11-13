import { createHash } from "node:crypto"
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
const URL_PLACEHOLDER = /__N8N_OPS_URL__/g
const VERSION_PLACEHOLDER = /__N8N_OPS_SKILL_VERSION__/g
// The address goes into JavaScript, PowerShell and sh source, and the skill prints it in commands, so only an origin
// of this shape is filled in (the same shape the skill's scripts accept).
const SAFE_ORIGIN = /^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:[1-9][0-9]{0,4})?$/

/**
 * Whether agents may fetch the skill from this address: https, or http to this computer (development), and nothing
 * in it a shell or the scripts' languages would treat as code.
 */
export function servesSkill(issuer: string) {
  if (!SAFE_ORIGIN.test(issuer)) return false
  const url = new URL(issuer)
  return url.protocol === "https:" || ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
}

function installNote(base: string) {
  const list = Object.keys(FILES)
    .map((f) => `- ${base}/connect/skill/${f} → n8n-ops/${f}`)
    .join("\n")
  const host = new URL(base).host.replace(/[^a-z0-9.-]/gi, "-")
  return `# Install the n8n-ops skill

Download these files into a folder named \`n8n-ops\` in your personal skills folder (Claude Code:
\`~/.claude/skills/\`, or \`$CLAUDE_CONFIG_DIR/skills/\` when it is set; Codex: \`~/.codex/skills/\`):

${list}

On Linux and macOS, make \`scripts/n8n-ops\` and \`scripts/n8n-ops.sh\` executable (\`chmod +x\`).

Change an existing \`n8n-ops\` folder only when an agent installed it from this address (you know it, or the person
confirms it). If it names another n8n-ops address, install into \`n8n-ops-${host}\` instead, under the same rule. Any
other copy (from Git, a tool, or a link) works as it is: connect with \`n8n-ops connect --url "${base}"\`.

The connection lives in the user's home folder (\`~/.n8n-ops\`), not in the skill's folder, so installing again needs no
new approval. Every agent of the computer user shares it: when one is connected already, \`n8n-ops connect\` answers
\`already_connected\`.

Then read the new \`n8n-ops/SKILL.md\` now, without waiting for skills to reload, and follow its Connecting steps. Show
the person the link and the code that \`n8n-ops connect\` prints in the reply that ends your turn.
`
}

/** The skill's files as shipped, with line ends made LF so the sh scripts work from a Windows checkout. */
function readSkill(skillDir: string | undefined) {
  if (!skillDir) return null
  const files = new Map<string, string>()
  try {
    for (const name of Object.keys(FILES))
      files.set(name, readFileSync(join(skillDir, name), "utf8").replace(/\r\n/g, "\n"))
  } catch {
    return null
  }
  // The served version: a short hash of every file's name and content, in a fixed order.
  const hash = createHash("sha256")
  for (const [name, text] of files) hash.update(`${name}\n${text.length}\n${text}`)
  return { files, version: hash.digest("hex").slice(0, 12) }
}

/** The version a served copy of this build's skill sends in X-N8n-Ops-Skill, or null when the build has none. */
export function servedSkillVersion(skillDir: string | undefined) {
  return readSkill(skillDir)?.version ?? null
}

/**
 * The skill for agents that run commands, served by n8n-ops itself with its public URL and version filled in, so the
 * person only tells the agent where it is. Public (the files hold no secret), never cached, only while agents are on,
 * and only from an https address: an agent runs what it downloads here.
 */
export function skillRoutes(issuer: () => Promise<string | null>, skillDir: string | undefined) {
  const app = new Hono<Env>()
  const skill = readSkill(skillDir)
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
          message:
            "Agents install the skill once agents are on and the public URL is an https address with a plain host name. An admin sets both in n8n-ops.",
        },
        404,
      )
    const file = new URL(c.req.url).pathname.slice("/connect/skill/".length)
    if (!skill) return c.json({ error: "not_found", message: "This build has no agent skill." }, 404)
    if (file === "") return c.body(installNote(base), 200, headers("text/markdown; charset=utf-8"))
    // Each file by the list's own name, never by the name in the request.
    const name = Object.keys(FILES).find((f) => f === file)
    const text = name ? skill.files.get(name) : undefined
    if (!name || text === undefined) return c.json({ error: "not_found" }, 404)
    const filled = text.replace(URL_PLACEHOLDER, base).replace(VERSION_PLACEHOLDER, skill.version)
    return c.body(filled, 200, headers(FILES[name] as string))
  })
  return app
}

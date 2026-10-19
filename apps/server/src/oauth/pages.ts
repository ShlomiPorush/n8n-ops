import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Design } from "../lib/settings.ts"
import type { ProviderPages } from "./provider.ts"

const htmlText = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch)

/** The built app's stylesheet, so these few server pages wear the app's fonts, colours and both designs. */
function stylesheet(webDir: string | undefined) {
  const file = webDir ? join(webDir, "index.html") : ""
  if (!file || !existsSync(file)) return null
  return /<link[^>]+href="(\/assets\/[^"]+\.css)"/.exec(readFileSync(file, "utf8"))?.[1] ?? null
}

const errors: Record<string, string> = {
  access_denied: "The connection was not approved. You can close this page.",
  expired_token: "This code has expired. Start the connection again in your agent.",
  invalid_request: "This link is not valid any more. Start the connection again in your agent.",
  invalid_client: "This agent is not known here. Start the connection again in your agent.",
  invalid_target: "This agent asked for something n8n-ops does not offer.",
  invalid_redirect_uri: "This agent asked to be sent back to an address it did not register.",
}

/**
 * The device flow's own pages (enter the code, compare it, done) and the authorization server's error page.
 * Server-rendered by the provider, so they carry its form and its protection against cross-site posts.
 */
export function providerPages(webDir: string | undefined, design: () => Design): ProviderPages {
  const css = stylesheet(webDir)
  const page = (title: string, body: string) => `<!doctype html>
<html lang="en" data-design="${design()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${htmlText(title)} · n8n-ops</title>
${css ? `<link rel="stylesheet" href="${css}">` : ""}
<script>try{var t=localStorage.getItem("n8n-ops-theme");if(t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}</script>
<style>
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:var(--ui-bg);color:var(--ui-ink);font:var(--ui-body)/1.5 var(--ui-font)}
main{width:min(420px,100%);display:grid;gap:16px;padding:28px;box-sizing:border-box;border-radius:var(--ui-r-lg);background:var(--ui-panel);box-shadow:var(--ui-shadow-card);border:1px solid var(--ui-line)}
h1{margin:0;font-size:var(--ui-title);font-weight:var(--ui-title-w);letter-spacing:var(--ui-title-ls)}
p{margin:0}.muted{color:var(--ui-muted)}.fail{color:var(--ui-fail)}
.code{font:600 28px/1.2 var(--ui-mono);letter-spacing:.12em;text-align:center;padding:14px;border-radius:var(--ui-r-sm);background:var(--ui-fill)}
input[name=user_code]{width:100%;box-sizing:border-box;height:46px;padding:0 12px;border:1px solid var(--ui-line);border-radius:var(--ui-r-sm);background:var(--ui-bg);color:var(--ui-ink);font:600 20px var(--ui-mono);letter-spacing:.12em;text-align:center;text-transform:uppercase}
input[name=user_code]:focus{outline:2px solid var(--ui-focus);outline-offset:2px}
.actions{display:flex;gap:8px;flex-wrap:wrap}
button{height:38px;padding:0 16px;border-radius:var(--ui-r-sm);border:1px solid var(--ui-line);background:var(--ui-bg);color:var(--ui-ink);font:600 var(--ui-ctl) var(--ui-font);cursor:pointer}
button.primary{background:var(--ui-accent);border-color:var(--ui-accent);color:var(--ui-on-accent)}
.brand{display:flex;align-items:center;gap:10px;font-weight:700}.brand span{display:grid;place-items:center;width:28px;height:28px;border-radius:var(--ui-r-sm);background:var(--ui-accent);color:var(--ui-on-accent);font-size:13px}
</style>
</head>
<body><main><div class="brand"><span aria-hidden="true">n</span>n8n-ops</div>${body}</main></body>
</html>`

  return {
    codeInput: (form, error) =>
      error === "denied"
        ? page(
            "Not connected",
            "<h1>Not connected</h1><p>The connection was not approved. You can close this page.</p>",
          )
        : page(
            "Connect an agent",
            `<h1>Connect an agent</h1>
${error === "wrong" ? '<p class="fail" role="alert">That code is not valid. Check it in your agent and try again.</p>' : error ? '<p class="fail" role="alert">That did not work. Start the connection again in your agent.</p>' : /type="hidden" name="user_code"/.test(form) ? '<p class="muted">An agent asks to connect. Continue to compare its code.</p>' : '<p class="muted">Enter the code your agent shows.</p>'}
${form}
<div class="actions"><button class="primary" type="submit" form="op.deviceInputForm">Continue</button></div>`,
          ),
    codeConfirm: (form, clientName, userCode, label) =>
      page(
        "Connect an agent",
        `<h1>Does your agent show this code?</h1>
<div class="code">${htmlText(userCode)}</div>
<p><b>${htmlText(label ?? clientName)}</b>${label ? ` <span class="muted">(${htmlText(clientName)})</span>` : ""} asks to connect to n8n-ops. Continue only if you started this yourself and your agent shows the same code. The name is what the agent says about itself.</p>
${form}
<div class="actions"><button class="primary" autofocus type="submit" form="op.deviceConfirmForm">Yes, continue</button><button type="submit" form="op.deviceConfirmForm" name="abort" value="yes">Cancel</button></div>`,
      ),
    success: (clientName, label) =>
      page(
        "Agent connected",
        `<h1>Agent connected</h1><p>${htmlText(label ?? clientName)} can use n8n-ops now. You can close this page; your agent carries on by itself.</p>`,
      ),
    error: (code, description) =>
      page(
        "Not connected",
        `<h1>Not connected</h1><p>${htmlText(errors[code] ?? "Something went wrong with this connection. Start it again in your agent.")}</p>${description && !errors[code] ? `<p class="muted">${htmlText(description)}</p>` : ""}`,
      ),
  }
}

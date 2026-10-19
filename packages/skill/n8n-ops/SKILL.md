---
name: n8n-ops
description: Read n8n-ops, the operations console of self-hosted n8n instances at __N8N_OPS_URL__ - open problems and failed executions, instance health, queues, backups, finding a workflow - and ask a person for temporary access to an n8n instance's API. Use it for anything about failing n8n workflows or the n8n instances n8n-ops watches.
---

# n8n-ops

n8n-ops (__N8N_OPS_URL__) watches self-hosted n8n instances. This skill reads it through its REST API with the
`n8n-ops` command in `scripts/`. A person approves this agent once; after that the command keeps the connection by
itself. Tokens stay inside the command: never open, print or copy the files it keeps.

## Running the command

- Linux, macOS, or Git Bash on Windows: `<this skill's folder>/scripts/n8n-ops <command>`
- PowerShell or cmd on Windows:
  `powershell -NoProfile -ExecutionPolicy Bypass -File "<this skill's folder>\scripts\n8n-ops.ps1" <command>`
  (the policy is bypassed for that one process; nothing on the computer changes)

It uses Node 20+ when installed, otherwise PowerShell on Windows or sh and curl elsewhere. Every answer is one line
of JSON on stdout. On failure the exit code is 1 and the answer is `{"error": "<code>", "message": "..."}`: tell the
person the message as it is.

## Connecting (once)

1. Run `n8n-ops connect`. It answers `{"status": "pending", "link": "...", "code": "..."}`.
2. Show the person the link and the code exactly as printed, and ask them to open the link, sign in, check that the
   page shows the same code, and approve. They decide whether this agent may also ask for instance access.
3. Run `n8n-ops connect --wait`. While it answers `still_waiting`, run it again. `connected` means done; `denied`
   or `expired` means start again only if the person wants to. If the person says the link or the code did not
   work, `n8n-ops connect --replace` gives a new one.

`status` says whether this agent is connected. The connection belongs to this agent install (the folder this skill
is in) and is shared by all its sessions. Run `disconnect` only when the person asks. If a command answers
`connection_ended` or `not_connected`, connect again the same way.

## Reading

`n8n-ops get '<path>'` prints the answer of `GET /api/v1/<path>` (`{"data": ...}`). Quote the path; percent-encode
spaces and other characters in query values.

| Path | What it returns |
|---|---|
| `problems?status=open&instance=<name>&q=<text>&limit=50` | Open problems on all instances: one per workflow, node and exact error, with failure counts. `status` is open, muted or resolved. |
| `problems/<id>` | One problem: error, stack, the failed node's input, the workflow graph with the failed node, recent executions, the same error elsewhere. |
| `problems/<id>/execution?failure=<failureId>` | The full stored failed execution (latest by default), with a link to it in n8n. |
| `instances` | Health, version and last check of every instance. |
| `queues` | Queue metrics and worker health of instances in queue mode. |
| `backups` | Last backup and last successful backup of every instance. |
| `workflows?q=<text>&instance=<name>` | Workflows by name, ID, webhook path or tag; each says its instance and whether access to it can be requested, with which scopes. |

## Temporary access to an n8n instance

Only when the task needs to change or read n8n itself, and only if the person allowed instance access when they
approved this agent (otherwise the command answers `insufficient_scope`: ask the person, then `connect --replace`).

1. Find the instance with `workflows` if you do not know it.
2. Ask: `n8n-ops post access-requests --json-file <file>` with a JSON body
   `{"instance": "<name>", "reason": "<what you will do and why, 10-500 characters>", "scopes": ["workflow:read"], "workflowIds": ["<id>"], "minutes": 15}`.
   Ask for the fewest scopes, workflows and minutes the task needs; a person reads the reason and decides. Writing
   the body to a file avoids quoting trouble; `--json '<body>'` also works in a POSIX shell.
3. Poll `n8n-ops get access-requests/<requestId>` every few seconds until it is approved or denied. Once approved it
   returns, one time only, a key and a base URL: call the n8n public API there with the key in the
   `X-N8N-API-KEY` header, exactly as with n8n.
4. As soon as the task is done: `n8n-ops post access-requests/<requestId>/release`. The key stops working at once.

## When the command cannot run

- `missing_curl`, `node_too_old`, or PowerShell blocked by policy: tell the person what is missing (curl, or Node 20+).
- `cannot_save` or `unreachable`: something (often a sandbox) blocks writing the connection's folder or reaching
  n8n-ops. Tell the person which, and do not keep tokens anywhere else.
- `insecure_credentials`: the connection's folder or file can be read by others; tell the person the fix it gives.
- `busy`: another n8n-ops command is using the connection. Nothing was sent; run it again.

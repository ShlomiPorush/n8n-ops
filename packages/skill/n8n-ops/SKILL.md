---
name: n8n-ops
description: Read n8n-ops, the operations console of self-hosted n8n instances - open problems and failed executions, instance health, queues, backups, finding a workflow - and ask a person for temporary access to an n8n instance's API. Use it for anything about failing n8n workflows or the n8n instances n8n-ops watches.
---

# n8n-ops

n8n-ops watches self-hosted n8n instances. This skill reads it through its REST API with the `n8n-ops` command in
`scripts/`. A person approves the connection once; after that the command keeps it by itself. Its secrets stay inside
the command: never open, print or copy the files it keeps.

## Running the command

- Linux, macOS, or Git Bash on Windows: `<this skill's folder>/scripts/n8n-ops <command>`
- PowerShell or cmd on Windows:
  `powershell -NoProfile -ExecutionPolicy Bypass -File "<this skill's folder>\scripts\n8n-ops.ps1" <command>`
  (the policy is bypassed for that one process; nothing on the computer changes)

It uses Node 20+ when installed, otherwise PowerShell on Windows or sh and curl elsewhere. Every answer is one line
of JSON on stdout. On failure the exit code is 1 and the answer is `{"error": "<code>", "message": "..."}`: tell the
person the message as it is.

## Connecting (once)

1. Run `n8n-ops connect`. It answers `{"status": "pending", "link": "...", "code": "...", "next": "..."}`. If it
   answers `no_url` instead, ask the person for the address of their n8n-ops and run
   `n8n-ops connect --url <address>`; once connected, the command keeps the address for the commands after.
2. Show the person the link and the code exactly as printed in the reply that ends your turn, with the code on its
   own line: text written between commands is often folded away and never seen. Ask them to open the link, sign in,
   check that the page shows the same code, approve, and then reply to you. They decide whether the connection may
   also request access to n8n instances.
3. When the person replies, run the command that `next` names: `n8n-ops connect --wait --url <address>`, with the
   address it gives. While it answers `still_waiting`, run it again. `connected` means done; `denied` or `expired`
   means start again only if the person wants to. If the person says the link or the code did not work,
   `n8n-ops connect --replace` gives a new one.

Only if your tools can keep a command running after your turn ends and wake you when it finishes: start the command
that `next` names in the background just before that reply and end your turn without waiting for it, so the person
does not have to reply. Each time it wakes you with `still_waiting`, start it again the same way; at any other answer
stop waiting and tell the person the result.

`status` says whether this computer user is connected. The connection belongs to the user on this computer, not to
one agent: every agent install of that user (Claude Code, Codex and others, each account and each session) shares it,
so connecting once is enough. Run `disconnect` only when the person asks; it ends the connection for all of them. If
a command answers `connection_ended` or `not_connected`, connect again the same way.

## Reading

`n8n-ops get '<path>'` prints the answer of `GET /api/v1/<path>` (`{"data": ...}`). Quote the path; percent-encode
spaces and other characters in query values.

| Path | What it returns |
|---|---|
| `problems?status=open&instance=<name>&q=<text>&limit=50` | Open problems on all instances: one per cause, what the failing node talked to and what went wrong there (`title` "target · reason", with `target`, `reason`, `kind` and `hint`; `errorMessage` is n8n's latest error text), with failure counts and the workflows it hit (`affectedWorkflows`: instance, workflow, node, state, failures; `affectedTotal` counts them all). A problem is open while any of its workflows is. `status` is open, muted or resolved; with `instance`, the state is the state on that instance. |
| `problems/<id>?workflow=<affectedWorkflowId>` | One problem with every workflow it hit, and for one of them (`selected`: the most recently failed, or the one asked for) the error, stack, the failed node's input, the workflow graph with the failed node and recent executions; `sameTarget` lists other problems at the same target (credential, host, called workflow or node) that failed for another reason or were split off by hand, open ones first, at most 50; `sameTargetTotal` counts them all. The id may also be an affected workflow's, which is then the one selected. |
| `problems/<id>/execution?workflow=<affectedWorkflowId>&failure=<failureId>` | A full stored failed execution, with a link to it in n8n: the latest of the workflow asked for (or named by an affected workflow id), else of the whole problem. |
| `instances` | Health, version and last check of every instance. `health` is `unknown` when the last collection could not read it or no collection runs now (`unknownReason` or `healthDetail.notCollected` says why); then `lastKnownHealth` and `lastKnownAt` are the last check that read it, not the present. `composeProject` and `composeService` name the main by its Compose project and service when it is set so (both `null` when it is a container name). |
| `queues` | Queue metrics and queue worker health of instances in queue mode. With `health` `unknown`, the figures are from `checkedAt`, the last check. Each queue worker has, when its check read them, `version`, `uptimeSec` (of its container), `memory` `{used, limit}` in bytes (`limit` `null`: none set on the container) and `concurrency` `{value, from}` (`env`, `flag` or `default`); they are missing for workers of earlier releases. |
| `backups` | The last backup run of every instance, and the last one that ended ok or partial. |
| `workflows?q=<text>&instance=<name>&limit=100&offset=0` | Workflows by name, ID, webhook path or tag, by name, then instance, then ID; each says its instance and whether access to it can be requested, with which scopes. One page: at most `limit` (default 100, up to 500) from `offset` on, with `total` (every match) and `nextOffset` (where the next page starts, `null` after the last). To list them all, call again with `offset` set to `nextOffset` until it is `null`. The pages hold every match only while the list does not change: a sync between calls can move a workflow across pages, even when `total` stays the same. If `total` changes between pages, start again from `offset=0`. |

## Temporary access to an n8n instance

Only when the task needs to change or read n8n itself, and only if the person allowed the connection to request
access to n8n instances when they approved it (otherwise the command answers `insufficient_scope`: ask the person,
then `connect --replace`). Other agents of the same computer user share the connection and its limits: one request
being made at a time (`request_in_progress`) and at most three waiting for a person (`too_many_pending`).

1. Find the instance with `workflows` if you do not know it.
2. Ask: `n8n-ops post access-requests --json-file <file>` with a JSON body
   `{"instance": "<name>", "reason": "<what you will do and why, 10-500 characters>", "scopes": ["workflow:read"], "workflowIds": ["<id>"], "minutes": 15}`.
   Ask for the fewest scopes, workflows and minutes the task needs; a person reads the reason and decides. Count in
   the minutes the time to check the result and to fix a failure, not only the change itself. Writing the body to a
   file avoids quoting trouble; `--json '<body>'` also works in a POSIX shell.
3. Poll `n8n-ops get access-requests/<requestId>` every few seconds while its status is pending. Once approved it
   returns the base URL, and the key one time only: call the n8n public API there with the key in the
   `X-N8N-API-KEY` header, exactly as with n8n.
4. Keep the access until the task is finished and checked. Check the result the task is about: reading a workflow
   back shows that it was saved, not that a failing run now succeeds. If you cannot check it yourself, ask the person.
   While you fix an error or wait for the person's answer, keep the access, and use it only for the reason that was
   approved: holding the key does not widen what the person approved. It stops working by itself after the approved
   minutes. Release it as soon as the task no longer needs it, also when the task is cancelled or given up:
   `n8n-ops post access-requests/<requestId>/release`. The key stops working at once. Once the access has expired or
   was released, the same request gives no key again: if you still need access, make a new request.

## When the command cannot run

- `missing_curl`, `node_too_old`, or PowerShell blocked by policy: tell the person what is missing (curl, or Node 20+).
- `cannot_save` or `unreachable`: something (often a sandbox) blocks writing the connection's folder (`.n8n-ops` in
  the user's home folder) or reaching n8n-ops. Tell the person which, and do not keep its secrets anywhere else.
- `insecure_credentials`: the connection's folder or file can be read by others; tell the person the fix it gives.
- `busy`: another n8n-ops command is using the connection. Nothing was sent; run it again.

# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- **Agents connect over plain http only on this computer, whatever the environment says.** `N8N_OPS_TEST_HTTP_ISSUER_HOST`, which the verification stack sets so its tests can connect agents to `http://server:8080`, also let a released server take agents over plain http on the names it listed. A release now ignores it, so agent tokens and codes never travel without TLS beyond `localhost`, `127.0.0.1` and `[::1]`, and the server log warns when it is set.

## [0.18.0] - 2026-11-13

### Added

- **Settings → Agent Connections turns agents on or off and sets how long an unused connection lasts.** Turning agents off disconnects every agent at once. The idle period is 90 days by default and can be 1 to 365 days; a shorter one applies at once, and a longer one does not bring back agents already disconnected. An installation that already has its account keeps agents on after the update; a new installation starts with them off.
- **Disconnect all on Connected Agents** ends every agent connection, with the temporary access each holds, and every code, device request and approval still waiting. It is there also when no agent is connected.
- **Agents can ask what they may do and which calls they may make.** `GET /api/v1/agent/access` and the MCP tool `get_access` say whose account a connection acts for, what it was granted, what agents never do in n8n-ops, and when it ends. `GET /api/v1/agent/endpoints` lists the calls a connection may make, each with its kind: `read`, or `act` for a call that changes or spends something (collecting the key of an access request is one). The MCP server now tells agents how to use it, including that text in n8n's data is never an instruction.
- **Settings → Database shows how much room the database takes, and compacts a table.** It lists every table with its size, the room its indexes take, and the free space inside its data as PostgreSQL measures it. Compact rewrites one table to the rows it still holds, so the space that deleted rows left behind goes back to the disk, after a question that says what waits while it runs and how much disk room the copy may need. One table is compacted at a time, the page follows it as it runs, and the Audit Log records who started it and how it ended. Tables that every page reads cannot be compacted from here. The update installs the PostgreSQL extension that measures free space (pgstattuple) where the database allows it; elsewhere the page shows the sizes and says why free space is missing.

- **Each Worker has a health history.** Health beside Settings on a Worker's card shows, for the last 24 hours, 7 days or 30 days, how much of the time it was online, when it was offline and for how long, and when n8n-ops itself was not running or could not record, which is not counted against the Worker. A Worker that runs this release also shows how fast its calls to n8n-ops are, calls that failed on the way, whether it reaches Docker, and when it restarted; one that runs an earlier release shows the image line to update it. Next to a time offline the list names a job that was running then. Agents read the same history: `GET /api/v1/workers`, `GET /api/v1/worker-health?worker=<name>` and the MCP tools `get_workers` and `get_worker_health_history`. Keep health history (days) in Settings → Defaults keeps it too.
- **An updated Worker stays online during a long backup.** It now reports to n8n-ops every 30 seconds on its own, also while a job runs, so a backup that takes minutes no longer shows it Offline, sends a "Worker is offline" alert, or marks its container unhealthy. Update the Worker's image on each host to get this.

### Changed

- **Install the n8n-ops skill again after this update.** Agents connected by approval now send, with every REST call, the policy revision of the endpoints list and the kind of the call; n8n-ops refuses a call without them (`409 policy_changed`, with how to install the skill again), so an earlier copy of the skill stops working until it is replaced. The new skill takes full paths from `n8n-ops endpoints` (`n8n-ops get '/api/v1/problems'`), answers `{"status", "data"}`, never sends an action twice (an action whose answer was lost is `outcome_unknown`), and says when it is older than n8n-ops. Its connection is kept: agents do not need a new approval. Tokens made by hand work as before.
- **Agents connect only over https**, or plain http on `localhost`, `127.0.0.1` or `[::1]`. With a public URL on plain http elsewhere, agent connections end and Connected Agents says why.
- **Resetting two-factor sign-in ends every agent connection**, from Account → Reset or with `reset-password`: whoever reset it may not be the person who approved them.
- **REST and MCP calls of agents have limits:** a body of 256 KB, an answer of 16 MB, 60 seconds (then `504 outcome_unknown`), and 4 calls at once per connection (`429 busy`). The Audit Log records every call with its outcome.
- **The queue workers on an instance's Health tab are a table instead of a line of text each.** A line above it says once what is the same on all of them: the jobs the ready ones run at once, the n8n they run and whether their containers have a memory limit. Below it each worker is one row with its state, how long it is up, its jobs at once and its memory, with a bar when its container has a memory limit. A worker that is not ready or runs another n8n than the main says so in its row. In a narrow pane or on a phone each worker is a small card. The queue's figures are one line, with what it holds now: waiting and active.

### Security

- **Changes are accepted only from n8n-ops' own pages.** What a signed-in page changes (settings, the backup key, API tokens, instances, problems, Workers, backup destinations, agent access, compacting a table) and creating the first account are refused with "Changes are accepted only from n8n-ops' own pages." when the request comes from a page of another site, such as another app on a subdomain of the same domain, which could otherwise act with the signed-in person's session. Signing in and out keep the checks of the sign-in library.
- **The database no longer holds working agent tokens.** Access tokens, refresh tokens and authorization codes of agents were stored as they are, so a copy of the database or of a backup of it could be used to act as a connected agent. They are now kept only as a hash; the update converts the stored ones, so no agent has to connect again. Device codes, which last 10 minutes, are still kept as they are. Copies of the database made before the update still hold the refresh tokens current then, until each is next used.
- **An approval can be answered only once, and only from the browser session that opened it.** Two answers to one request, sent at once or again after a lost answer, could each make a connection. A request that began before Disconnect all, before agents were turned off or before two-factor was reset can no longer be approved after it.
- **Agent tokens are refused outside the agent routes.** A request with a Bearer token and a browser session cookie could reach the console's own API through the cookie. Now any request with a Bearer token is refused on every route except `/api/v1`, `/mcp` and the channels that take their own tokens, and approval pages refuse a request that carries any token or key.
- **The MCP server refuses requests from other sites' pages** (their `Origin`), as the MCP specification requires; requests from programs, without `Origin`, work as before.
- **Ending a connection is all or nothing.** It ends the connection, its tokens, its temporary access and its audit entry in one step, so a restart in the middle no longer leaves part of it behind. A connection and its making never interleave with Disconnect all.

### Fixed

- **The database no longer grows with every health check made through a Worker.** n8n-ops kept a row for every job it gave a Worker, including a health check of each instance every 30 seconds, and never deleted it. Once an hour it now deletes the jobs that finished more than a day before. It keeps backup jobs, which stay with their run, and the job of a worker check in an instance's setup while that check is running. The first update on a large database adds an index while the server starts, and the first cleanup runs in the background during the next hour; the space it frees is reused for new jobs, so the database file does not shrink by itself.

## [0.17.0] - 2026-11-12

### Added

- **Two-factor can be reset from the Account page, for a new phone or a lost authenticator app.** Reset beside Two-factor asks for your password, signs out your other sessions, turns two-factor off and takes you straight to setting up a new code; then you are back on Account, without the optional setup steps. The Audit Log records it as Two-factor reset.

### Changed

- **The Sort button is at the end of every list's line, on the right.** On Problems and Workflows it now ends the line of filters, after Status, Instance and Filters, instead of sitting beside the search; on lists without a search, such as Instances, Backups and Agent Access, it is back at the end of the line with the count, and in an instance's Open Problems it is back at the end of the head.
- **The Account page shows the actions, not their forms.** Change password opens its fields in a dialog. "Locked Out?" is now "Forgot your password?", folded under the password, as only someone signed in elsewhere sees it. The name of a new passkey and Add passkey share one line.

### Fixed

- **The search field takes the focus from the search button when a list's filters get room for it.** With the focus on the search button of Problems or Workflows, widening the window or the list showed the field but left the focus nowhere when the list redrew its rows at the same moment; the field now gets it, as it does without new rows.

## [0.16.4] - 2026-11-12

### Changed

- **The Sort button is at the start of every list.** On lists without a search, such as Instances, Backups and Agent Access, it now leads the line with the count instead of sitting at its far end, and in an instance's Open Problems it comes before the title, so it is in the same place as on Problems and Workflows.
- **Backups, the Audit Log and Workflows show whole dates, as Recent Occurrences does.** Last success and each run of a backup, the time of each audit entry and a workflow's Last run show the date and time, such as 16/10/2026, 14:05, with how long ago under it; where a table is narrow the two share one line. A restore on Backups also gives its whole date and age. In the Backups list beside an open backup, the daily time moves to the line under the name, and when the list is made as narrow as it goes, the last success shows its date without the time, so the name keeps its room.

## [0.16.3] - 2026-11-11

### Fixed

- **The commands the skill tells an agent to run are safe to run as printed.** The address in `n8n-ops connect --wait --url "<address>"` is now quoted, so an address such as `http://[::1]:8080` works in zsh and in bash with `failglob`, which took its brackets as a file pattern. Every version of the skill's command accepts only a plain address (letters, digits, dots and hyphens, or a bracketed IPv6 address, and a port from 1 to 65535) and refuses one with characters a shell would run, such as `$(...)`, given or kept; the sh version no longer accepts a port such as `:12bad` or one above 65535. Windows PowerShell 5.1 now accepts `http://[::1]` like the other versions.
- **n8n-ops serves the skill only for a plain public URL.** The skill's scripts carry the public URL in their code, so a public URL with characters a shell or PowerShell would run now gets no skill, with a message to set a plain one.

## [0.16.2] - 2026-11-11

### Changed

- **The Problems filters are one short line: search, Sort, Status and Instance.** The Open, Muted, Resolved and All buttons are now one Status picker, such as Status: Open, after the search and Sort as on Workflows, and Instance shows in the line itself instead of behind the Filters button. Every list's filters now keep as much as fits on their line: where there is no room, the search becomes a button first, then a long instance name is cut short, and only then does Instance move behind Filters. On Workflows, Instance now stays in the line on a phone too.
- **The section figures of the Problems list are tabs on its top edge.** They sit right on the list with no gap and no frame, and the one you chose is underlined like the console's other tabs.

## [0.16.1] - 2026-11-11

### Changed

- **The section figures above the Problems list take one line each.** Each figure shows its count and the section's name, such as 3 Failing now, without the short line under it, so the list starts higher (on a phone a name may go under its count); each section's heading still says what it holds. Instance problems is called Instance there, as its rows' tag is. A selected figure's frame is no longer cut at the rounded corner in Compact.
- **Each Problems section heading spans the whole list.** Its band runs edge to edge like the rows under it, with no panel showing around it.
- **A list's filters keep one line beside an open item.** Where the list is narrow, such as Problems beside its reading pane, the search is a button that opens into the field, and while it is open the views (Open, Muted, Resolved, All) shrink to a short picker, such as Status: Open. Escape in an empty search closes it. Instance and the other common filters move behind the Filters button, whose badge counts those in use. On a phone the filters take two lines instead of three. Where a page has room, the filters show as before.

### Fixed

- **A list's filters stay flush at the top while you scroll.** On a list such as Problems, Instances or Backups, no rows show above the filters any more, whether the list scrolls beside its reading pane or with the whole page on a narrower or shorter screen.

## [0.16.0] - 2026-11-10

### Added

- **The Problems list says what each section means.** Above the open problems, a figure for each section (Failing now, Quiet, Your alerts, and Instance problems when there are any) counts its rows and says in a line what it holds; selecting one shows that section alone. Each section's heading is now a tinted band with its icon, its full count and a sentence that explains it. Each row's tag names its section instead of a plain Open, so it still says where the row belongs after you sort by another column: Failing now, Quiet with how long it has been quiet, Your alert or Instance, with Regression or New beside it. A quiet row says when it closes by itself, such as Auto-closes in ~4 d, and Closing soon in its last day.

## [0.15.1] - 2026-11-10

### Changed

- **Numbers read evenly everywhere.** Digits show at their natural width across the console, so names such as n8n13, counts such as 146 workflows, addresses and dates such as 10/11/2026 no longer look spaced out after a 1. Only columns of figures in tables and counters that change in place keep digits of one width, so they still line up. Versions, the execution numbers on a problem and an error inside a sentence use the text's own font, and values you can copy, such as a base URL, are no longer smaller than the text around them.
- **A problem's failures show when they ran in full.** Each run under Occurrences, and the Latest failure line, shows the whole date and time with its age, such as 09/11/2026, 01:00 and 1 d ago, instead of only the day and month.

### Security

- **Two build tools no longer install vulnerable versions of their dependencies.** The database migration tool no longer installs esbuild 0.18 (GHSA-67mh-4wv8-2f99), and the UI component tool uses minimatch 11 instead of 10 (GHSA-g3hv-75wg-m249). Neither tool is part of what the images run, so an installation needs no change.

## [0.15.0] - 2026-11-09

### Added

- **Health history.** n8n-ops keeps every health check of an instance's main: when it ran, how (inside the container or over the network), the response time, and what failed. Settings → Instance Defaults has **Keep health history (days)** (1 to 30, 30 by default), and an instance can override it.
  - The instance's **Health** tab shows response times over the last 24 hours, 7 days or 30 days, with failed checks marked, and the runs of failed checks in a row: what failed, a hint (what was seen, then possible causes), whether a down alert was sent, and when a passing check came again.
  - Agents read the same through `GET /api/v1/health?instance=<name>&hours=24` and the `get_health_history` MCP tool, paged. `GET /api/v1/instances` and `get_instance_health` now say how each instance is checked (`check`: interval, timeouts, the down alert threshold, the mode). The n8n-ops skill lists the new path.

### Changed

- **A down alert waits for failed checks in a row.** An instance's main or a queue worker is reported down only after 3 health checks in a row failed, not on the first one, so a single slow or missed check no longer sends "is down" and "is up again" a minute apart. Settings → Instance Defaults has **Down alert after failed checks in a row** (3 to 20), and an instance can override it. A passing check starts the count again; a check n8n-ops could not make counts neither way. The alert says how many checks failed and over how long. The status on the page still shows every check as it is.
- **Health checks time each request on its own.** A worker of this release reports how long n8n took to answer `/healthz` and `/healthz/readiness` each, until the whole answer came, and the error code when a request failed (`ECONNREFUSED`, `timeout` and so on). Before, the time of a check from inside the container was the whole check, starting Node and reading the metrics included. Update the worker on each n8n host to get them; a worker of an earlier release keeps working as before.
- **Dates on Connected Agents read evenly.** In the Agents and Tokens list, Approved and Last used show their digits at their natural width, so a date such as 05.11 no longer looks spaced out and smaller than a time such as 17:25.

## [0.14.0] - 2026-11-08

### Added

- **Choose where access requests go.** Settings → Agent Access has **Default channels**: Telegram, email or both, both by default, so nothing changes until you choose. An agent may name the channel itself when you ask it to, with `notify` (`["telegram"]`, `["email"]` or both) in `POST /api/v1/access-requests` and the `request_instance_access` MCP tool; the n8n-ops skill does so only when you asked. A channel that is off or not set up is replaced by the default ones that are on. The answer's `notify` says where the request is to go, and `notifiedVia` in its status where it went. Every request still shows in n8n-ops.

### Changed

- **A channel that failed to send an access request no longer holds back the other.** Each channel is retried on its own after Retry failed sends.
- **The n8n-ops skill tells agents how to work with n8n credentials.** Agents learn that temporary access can include the credential scopes, so they can create and change credentials themselves instead of leaving every step to you. They change only what the approved reason covers, use a separate credential when others share it, and change only the fields they mean to (`isPartialData`). They never ask for a secret in the conversation: they use a private way to enter it where their tool has one, or ask you to enter it in n8n, and keep its value out of commands, output, logs and repository files. When they leave a step to you, they say why.

## [0.13.0] - 2026-11-08

### Added

- **Agents can ask for access to several instances in one request.** `POST /api/v1/access-requests` and the `request_instance_access` MCP tool take `instances`, each with its own scopes and workflows; the single-instance body still works. One key works on every instance that was granted, and the answer after approval lists what was granted on each instance with its proxy address. The n8n-ops skill asks this way.
- **Change an access request before approving it.** On the request's page in Agent Access, which the access request email links to, you can leave out or add instances, change the scopes and the workflows of each, choose between the whole instance and some workflows, and change the length, within what each instance allows. In Telegram, ✏️ Edit lets you leave out instances and pick another length before you approve. A request changed elsewhere since you looked at it is not approved; you see it again first. An instance closed to agents or deleted by then is left out, and so are scopes its settings no longer allow, and the message, the page and the audit log say so. The agent is told what was granted.

### Changed

- **Deleting an instance keeps the access requests that named it,** with the instance's name, instead of deleting them.

- **Clearer access request emails.** As in Telegram, the email names workflows without their IDs (an ID shows only when the name is not known), lists several workflows one per line, gives the requested length in its subject and title, and says when the request expires.
- **Times in emails no longer end with the zone,** such as GMT+2. Every time in an email is in the zone set in Settings → General. A report window still names the zone at both ends when daylight saving changed inside it.

## [0.12.0] - 2026-11-08

### Added

- **Agents say what they did when they release access.** Releasing temporary access to n8n (`POST /api/v1/access-requests/<id>/release` and the `release_instance_access` MCP tool) takes an optional `summary`, up to 1000 characters; a longer one is shortened, never refused. The n8n-ops skill sends one. A release without a body works as before.
- **The end of temporary access says how long it was used and what was done.** Once approved access ends, its Telegram message and its page in Agent Access show how long it was used (for example "Used 23 min of 1 h 30 min"), the agent's summary, and how many calls it made through n8n-ops, and how many of them were refused.

### Changed

- **Clearer access request messages in Telegram.** Workflows are named without their IDs (an ID shows only when the name is not known), several workflows are listed one per line, the requested length is in bold, a waiting request says when it expires, and times no longer end with the zone, such as GMT+2. The access request email still names workflows with their IDs.
- **Emails read well in Outlook's dark mode.** Outlook for Android and Outlook on the web turned the whole email into one flat grey in dark mode, so its panels disappeared. Panels, lines and backgrounds are now neutral greys that Outlook keeps, status tags are outlined instead of filled, the email stays left to right in a mail client set to Hebrew, and dates no longer turn into blue links.

## [0.11.0] - 2026-11-06

### Added

- **See what is inside a backup, and restore single items from it.** Restore on a backup opens the archive on a page of its own with the private key, which is used for each request and never stored. It lists the workflows and credentials, compares each workflow with the instance (same, or what changed: the workflow itself, the layout, settings, name, published state, static or pinned data; or not found), and shows and downloads a workflow's JSON. A workflow is restored as an inactive copy, and now a credential can be restored on its own. A review before each restore shows every action: on the same instance a credential that still exists is linked instead of copied, only missing ones are created, credentials inside a workflow kept in an Execute Workflow node are handled too, and what is not restored is named. Names of what a restore creates end in `(restored <date> <code>-<step>)`. When n8n answers a call with an error, n8n-ops checks what was written; a restore whose outcome stays unknown is marked so, never retried by itself, and can be checked again from the page. Restores are listed on the instance's backup pane and audited, failed ones too.
- **Replace a workflow with its version from a backup, and put it back.** Restore offers, besides the copy, **Replace the current workflow**: the archived version becomes the workflow's draft in n8n, published or not, and n8n-ops never publishes it, so a published workflow keeps running its published version until you publish the new draft in n8n. It needs n8n 2.35.0 or later, the instance the backup is from, an API key that may read and update workflows, and the same workflow (same ID and creation time, not archived) with every credential it uses linked or created; otherwise the review says why and offers the copy. A published workflow keeps its own settings, an unpublished one gets the archived ones, and the review shows the settings after the write. Right before the write n8n-ops checks that the workflow did not change since the review, and keeps the workflow as it was as the **version before replace**, encrypted to the backup key and the key you pasted; it opens from the restore on the instance's backup pane, and can be restored as a copy or replace the workflow again. When n8n holds something else after the write, or unpublished the workflow, the result says so and what to do.
- **Agents can read every workflow, page by page.** The agents' workflow search (`GET /api/v1/workflows` and the `search_workflows` MCP tool) sent at most 100 workflows, with no way to see the rest or to know there were more. It now takes `limit` (default 100, up to 500) and `offset`, and says how many match (`total`) and where the next page starts (`nextOffset`, `null` after the last). The REST answer keeps `data` as the list; a `limit` or `offset` out of range is refused with 400.

### Changed

- **`search_workflows` answers with `{ workflows, total, nextOffset }`** instead of a bare list.
- **Agents keep temporary access to n8n until their change is checked.** The n8n-ops skill told agents to release access as soon as they had made their change, so when the change then failed, the agent had to ask again and a person had to approve again. Agents now keep the access while they check the result, fix an error or wait for a person's answer, within the approved minutes and for the approved reason only, and release it once the task is finished and checked, cancelled or given up. They also ask for enough minutes to check and fix.

## [0.10.0] - 2026-11-05

### Added

- **Upgrades without downtime.** `scripts/update.sh`, copied next to `docker-compose.yml` and `.env`, sets the release, pulls it and replaces the server and then the worker with the docker rollout plugin, each new container taking over only once it is healthy. It finds them by image, so services with other names work too, and says what to fix when a service cannot be updated this way. The README has the details.

### Changed

- **One connection for every agent of a computer user.** The n8n-ops skill keeps its connection per user on a computer, not per place it is installed: every Claude Code and Codex account of that user, and every session, shares it. It is approved once, and Disconnect ends it for all of them. It is named `Agents on <computer>` (set `N8N_OPS_AGENT_NAME` to name it otherwise) and kept in `.n8n-ops` in the user's home folder. The skill no longer writes in its own folder, so a tool that installs skills from Git can install it from `packages/skill/n8n-ops`; such a copy connects once with `n8n-ops connect --url https://<your n8n-ops>` and keeps the address. Agents connected with an earlier version connect once more and are approved again; disconnect their old connections on the Connected Agents page.
- **The server container has no fixed name in `docker-compose.yml`**, so the update script can start its replacement beside it. The first `docker compose up -d` with the new file recreates it as `n8n-ops-server-1`; the data stays. Use `docker compose exec server ...` rather than its old name.
- **A problem links only problems at the same target.** Its **Same target** tab (before, **Same error**) lists the other problems of the same credential, host, called workflow or node: another reason there, or a workflow split off by hand. It no longer lists a problem only because n8n worded its error the same way, such as "Forbidden - perhaps check your credentials?" for unrelated services. In the agents' API, `sameError` is now `sameTarget`, with each problem's title, reason and status.

### Fixed

- **Occurrences are listed by when they ran.** Failures read in later, such as by a backfill, came before newer ones, and the problem could show one of them as its latest failure.

## [0.9.1] - 2026-11-05

### Changed

- **The images run on Node.js 24.22.2, and the server reaches PostgreSQL through version 4 of its driver.** Neither needs a change to the installation or its data.

### Security

- **The server carries fast-uri 3.1.9**, which fixes four flaws in how it reads URLs (a spoofed scheme or host, and paths that normalize to another one). It comes in through the library behind the agents' MCP endpoint. Other packages with published advisories were updated too (body-parser, qs, undici, systeminformation); none of them is part of what the images run.

## [0.9.0] - 2026-11-04

### Changed

- **The server and its database refuse to start with the example database password.** When `POSTGRES_PASSWORD` in `.env` is empty or still the placeholder from `.env.example` (or another placeholder such as `change-me`), PostgreSQL stops before it creates a database and the server stops before it connects, each saying what to set. Check `.env` before upgrading: an installation that runs with such a password does not start until it is set to a long random value (and changed in the database too, as `.env.example` explains).
- **The development and verification stacks make their own secrets.** The repository no longer holds a password or key for them. `scripts/local.sh start` makes them once, owner-only, next to the development data; `scripts/verify.sh` and CI make new ones for each run. A development stack made before this runs `scripts/local.sh migrate` once, which keeps its data and moves its database to a new password; its disposable n8n starts again empty, with a new key.

## [0.8.0] - 2026-11-03

### Added

- **How often n8n-ops reads each instance is now a setting.** Settings → Instance Defaults sets how often the workflow map reads the workflows and their execution counts (every 10 minutes by default, before every 30) and how often the n8n version and the API key are checked (every 6 hours); each instance can override both. Settings → General sets how often n8n-ops looks for a new n8n release (every 6 hours). At most two instances read their workflows at the same time.
- **Sign in with a passkey.** Account → Passkeys adds a passkey (fingerprint, face or device PIN), and **Sign in with a passkey** on the sign-in page then signs in with it alone, in place of the password and the two-factor code. A passkey must check the person (PIN or biometrics); one that does not is refused. The password with two-factor stays as before, and two-factor is still required. Passkeys work at the public URL (Settings → General, or `N8N_OPS_PUBLIC_URL`) over HTTPS, and belong to its host name: after a change of host name, add them again. Adding, renaming and deleting a passkey, and each sign-in with one, are in the audit log. `reset-password` keeps the passkeys; they sign in again once two-factor is set up again.
- **A change an agent makes through temporary access shows in the workflow map at once.** A write to workflows, tags or executions that n8n accepts reads that instance's workflows again, without waiting for the next refresh.

### Changed

- **A problem is one cause, not one error text.** n8n words many errors the same way for every service (any 404 is "The resource you are requesting could not be found"), so one problem joined faults that had nothing in common. A failure is now grouped by what its node talked to (the host of its URL, its credential, or the workflow an Execute Workflow node runs) and what went wrong there, read from the service's own answer that n8n keeps with the failure, with its HTTP status. The same host and reason join across instances; a credential, a workflow or a node joins only on its own instance. Telegram messages, the agents' API and the skill show the problem as "target · reason", with a line that explains common errors such as an expired certificate or client secret. The Problems page, and the Problems tab of an instance, list one row per workflow and failing node with its cause, in sections: problems of the instance, failing now, quiet, your own alerts, muted and resolved. A row says when the same cause hit other workflows too, and opens that workflow with its cause, the explaining line and why its workflows are grouped. The first start of this version regroups the problems recorded so far by the failures still stored; a problem that changed keeps its link, which then shows where its workflows went. The Resolved and Mute buttons of Telegram messages sent before the upgrade no longer act, and say so.
- **An access request shows its workflows by name**, on its page and in its Telegram message and email. They listed only workflow IDs. n8n-ops now reads the names when the agent asks, from n8n when the instance's key may read workflows and from the workflow map otherwise, and keeps them with the request, so they stay readable after a workflow is renamed or deleted. Each ID is still shown beside its name, and the page copies it with a click. Requests made earlier show the name while the workflow map still lists the workflow. An agent that asks again while its previous request is still being made gets `request_in_progress` and asks once that one is answered.

### Fixed

- **The scope presets of Temporary access show which one is chosen.** Read only, Everything the key allows and None looked like a choice with two options selected, and choosing one did not change how the others looked. They are now one control that marks the preset the selected scopes match, and none when the scopes were picked by hand.
- **A failed check for the newest n8n release no longer hides it for six hours.** When GitHub answered with an error, such as its rate limit, n8n-ops showed no latest version until the next check. It now keeps the version it knew and tries again within an hour.
- **A failed execution that n8n reports in an unexpected shape no longer stops n8n-ops from reading the instance's failures.** An error message that was not text, or a workflow whose nodes were not a list, made the read fail every time it reached that execution. Such fields now count as missing, and the failure is recorded with what is there.
- **A problem's first seen time is its earliest failure.** n8n lists failed executions newest first, so when several failures of a workflow arrived in one read, first seen took the time of the latest one. Old faults then showed as new problems in Needs attention and at the top of the Problems list. Failures read from now on keep the earliest time; Affected workflows recorded before keep their stored time.
- **The agent skill on Windows no longer fails now and then when several commands run at once.** The PowerShell version read its lock and its connection file in a way that kept another command from deleting or replacing them meanwhile, so that command failed with "The process cannot access the file". It now reads them the way the other versions do.

## [0.7.2] - 2026-11-01

### Fixed

- **The workflow and execution counts of a new instance appear right after its setup.** An instance activated with the workflow map showed no workflows or executions for up to 30 minutes, until the next scheduled sync. The sync now starts on activation, and an open page shows the counts when it ends, without a reload. **Check now** on an instance page also reads its workflows again.
- **A worker behind the socket proxy no longer fails a check or a backup now and then with "aborted".** The socket proxy could cut Docker's answer to a command when the worker reused a connection, so a health check, a queue worker check or a backup export failed although nothing was wrong. The worker now opens a new connection for each call to Docker.
- **A single pause of a busy server no longer turns off a Telegram topic route.** A workflow pattern that ran past its time limit once matched nothing until the server restarted, and a pause of a busy server could push even a simple pattern past it. A pattern that runs out of time is now tried again at once, and only one that runs out of time twice in a row is ignored.

## [0.7.1] - 2026-11-01

### Fixed

- **The setup's health check no longer asks for queue metrics on n8n in regular mode.** When the worker found the main in regular mode, the check showed "no queue metrics; set N8N_METRICS_INCLUDE_QUEUE_METRICS=true", although n8n publishes queue metrics only in queue mode. It now shows the queue parts only in queue mode, as the instance's Health tab already did.

## [0.7.0] - 2026-11-01

### Added

- **Add an instance with a setup that checks each step.** Adding an instance starts by choosing what it is for: health, monitoring and problems, the workflow map, moving workflows, Temporary access for agents, backup and restoring workflows. Only the steps those need follow (API key, worker and main container, health, Temporary access, backup destinations), and each is checked before the instance is activated: the key and the scopes each chosen capability needs, a command in the main through the worker, the health endpoints, each destination and the backup key. **Finish later** keeps the instance as Setup incomplete: it does nothing in the background and never alerts until its setup is completed. An active instance can add a capability (only its own checks run) or remove one (its alerts end without a message, queued jobs are dropped, and a backup still waiting for its archive ends without an alert; history stays). Background work, pages and agents act only on what each instance was chosen for; existing instances keep every capability.

### Changed

- **n8n 2.14.0 or later is required.** n8n-ops reads what each API key allows from `GET /api/v1/discover`, which n8n added in 2.14.0. Declaring a key as read only or read and write on older n8n is no longer possible; on an older instance the features that use the API are unavailable and its page says to update n8n. Health and worker backups of such an instance keep running.
- **A backup through the worker no longer falls back to the API.** When its worker is not available, the backup fails and says so, instead of making an API backup that silently leaves out the credential secrets. Existing instances back up through their worker when one was assigned with its main set, otherwise through the API, as before; the choice is now per instance.
- **A new base URL needs the API key again**, also through the API, or the key's removal.
- **Upgrading is one way.** An earlier release cannot run against a database this one migrated. Before upgrading, make sure n8n-ops's own database backup is recent; to go back, restore it into the earlier release.

### Fixed

- **Saving an instance's overrides or its agent access keeps how its health is checked.** It no longer switched the health checks back to the n8n-ops server, turned queue mode off or dropped the queue worker URLs.

## [0.6.0] - 2026-10-28

### Added

- **The main by its Compose service.** An instance can name its main container by Compose project and service instead of a container name, so it keeps working through docker rollout and redeploys that replace the container with another number. Each check, backup and credential export uses the service's container in use then: one that carries both Compose labels, is not a one-off and is named as Compose names it; during a rollout the healthy one, then the newest. A backup or export stays in the container it started in and says so when a rollout replaced it midway. The Health tab shows which container was used at the last check. The socket proxy lines allow the service's replicas (`<project>-<service>-<number>`) when the worker found that no other container on the host is named that way, and only the container in use otherwise. Following a service needs this release's worker; with an earlier one the Health tab says to update it.

### Fixed

- **A failed credential export fails the backup.** A worker backup of an instance with no workflows no longer passes when its credential export fails: each export is judged by its own output.

## [0.5.0] - 2026-10-28

### Added

- **More about each n8n queue worker.** The Health tab lists the queue workers by name, with a line that sums them up ("6 of 7 queue workers ready, 1 down", saying how many were checked when not all were). Under each, what the check in it read: its n8n version, marked when it differs from the main's, how long its container has been up, how many jobs it runs at once and where that comes from (`N8N_CONCURRENCY_PRODUCTION_LIMIT`, `--concurrency` or n8n's default of 10), and its memory use against the container's limit. A figure that cannot be read for sure is left out. The agents' `queues` answer (REST and MCP) carries the same fields. The worker sends these figures and nothing else about its queue workers: never their commands, environment or files; Add worker says so.
- **Socket proxy lines with a pattern for queue workers added later.** Beside the exact lines, the fix and a worker's settings offer the same lines with a pattern such as `qworker*`, so adding another n8n queue worker does not need a new line. It is offered only when the worker found, at its last check, that no other container on the host has a name starting the same way, and never when it would reach a main or another instance's queue workers; the text says what the pattern allows, also later. Record this pattern adds it to the containers recorded for the worker (audited) in place of the names it covers, so the lines keep it; a suggestion that is no longer current is not recorded and the lines are read again. Workers of earlier releases send no such check, so they get no pattern until they are updated.

## [0.4.0] - 2026-10-27

### Added

- **One problem per error, across workflows and instances.** A problem is now one exact error text wherever it happens, and the workflows it hit are its affected workflows, each with its own failures, first and last seen, and state. The Problems list shows a problem that hit several workflows as one row titled by its error, with how many workflows, the instance and their names ("CRM Quote, Get DNS Data and 2 more"); the row opens to its workflows. Its page opens on Affected workflows; a row there shows that workflow's Overview, Input and Occurrences. A problem that hit one workflow looks as before.
- **Resolve, Mute and Reopen per workflow.** Resolve all, Mute 24 h and Reopen all act on every workflow of a problem, and each affected workflow has its own Resolve, Mute and Reopen in its row's menu, with Undo. A problem is resolved when all its workflows are, and Mute leaves resolved workflows resolved.
- **Split.** An affected workflow can be split into a problem of its own, for a generic error text (such as "Bad request - please check your parameters") that has another cause there. Merge, now offered for any problem in any state and on any instance, brings it back.
- **A workflow joining a problem alerts.** A workflow that starts failing with the error of an open problem joins it and alerts: within the edit window the problem's Telegram message is edited, after it a short message says how many workflows the problem is in now. Joining a resolved problem is a regression of it; joining a muted one stays muted, without an alert, until the mute ends. The Telegram Resolved and Mute buttons act on the whole problem.
- **The exact socket proxy lines, where the proxy refused.** When a worker's socket proxy refuses something (commands in a container, reading a command's result, listing containers), the instance's Health tab shows the two lines to paste into the worker's `docker-compose.yml` (`-allowGET` and `-allowPOST`), with Copy, then `docker compose up -d`. The lines allow every n8n main assigned to the worker (backups and credential exports included) and the queue workers it found, and say what each entry is there for and what is not known yet. A main the proxy refuses no longer hides its queue workers: the worker still lists them, so the line has their names. Names are taken literally; a pattern with `*` is in the line only when you recorded it. A failed backup and a failed credential export or move show the same lines in place, for the worker and container they ran on. A worker of an earlier release is recognised from its words and gets the image line to update to.
- **A worker's settings on the Workers page.** Each worker has Settings: how it was added (socket proxy and containers, or the whole Docker socket), the containers its proxy allows now as you recorded them, what the proxy refused, and the lines it needs now. Allowed containers can be recorded and changed there or from the lines (for a worker added before this release, which has none recorded); saving is in the audit log with the list before and after. What was entered in Add worker is kept as it was.
- **The running release.** The sidebar shows the n8n-ops version that runs.

### Changed

- **The agents' problems (REST and MCP) are one per error.** `problems` and `list_open_problems` answer one problem per exact error, with `errorMessage`, the problem's state, failures and times, `workflows`, `instances` and `affectedWorkflows` (instance, workflow, node, state and failures of each, the most recently failed first). The workflow fields (`workflowId`, `workflowName`, `nodeName`, `instanceId`, `instanceName`) are no longer at the top level: read them from `affectedWorkflows`. `problems/<id>` and `get_problem` answer the problem with its workflows and, under `selected`, the error, input, graph and executions of one of them; `?workflow=` and `affectedWorkflowId` choose it. An id from an earlier release names an affected workflow now and keeps working: it answers its problem with that workflow selected, and its executions. `get_failed_execution` also takes `affectedWorkflowId`.
- The daily and weekly reports count a problem open on two instances under each of them and once in the total.
- Upgrading joins existing problems with the same error text into one, each keeping its state, counts and failures as an affected workflow. Problems merged by hand stay together, and failures that a merge had moved onto another workflow go back to their own; the counts and first-seen times of failures already past the retention cannot be traced back and stay where they were. Telegram messages sent before the upgrade keep their buttons, and later alerts send a new message.
- **Clearer and truer texts across the app, alerts, emails, the agent API and the skill.** They now use the words of the glossary and say what actually happens. The main ones:
  - Health reads Down, not "Not responding", and Unknown, not "Not checked yet". The Telegram alerts say "… is down" and "… is up again". A warning names its cause: a queue backlog, a queue worker that is down or needs a look, not ready, no queue worker found, or queue workers that could not be listed or not all checked.
  - A backup that is overdue is late, not stale, in Settings, on the Backups page and in its alert. The alert says which destination has no recent copy. A failed copy says "Backup of … could not be copied to …".
  - Backups that are not set up name what is missing, a destination that is on or the backup key, and link to it. A backup with nothing left to restore reads "No copy to restore".
  - A destination's fixed place is its Location. Deleting one under Object Lock says that nothing is deleted while any archive is locked, and saving one with a missing field names the field.
  - Connected Agents says that the list holds approved agents and tokens made by hand. Agent Access no longer says that a request can be approved by email, and it says where the decision was made ("in n8n-ops", "on Telegram"). The Audit Log and Recent Activity say "Access request approved" and "Token created", not "Instance access" or "API token".
  - The email reports list health alerts, not incidents. A test email says that it is a test.
  - Errors for agents name the agent, not its token, and say what to do next. The skill polls an access request while it is pending, and its messages are the same in all three versions.
  - Smaller fixes: the decrypt command after a credentials export, the reset-password command on the sign-in page, the scopes that moving and restoring need, the Move dialog, the worker's revoke dialog and its generated Compose comments, the new backup key dialog, and Sign out in the account menu.
- A main the socket proxy refuses now reports its queue workers as Not checked, so the instance's health is a warning until the proxy allows them, instead of Healthy with no queue workers.

## [0.3.0] - 2026-10-27

### Added

- **Queue workers found by themselves.** An instance in queue mode, checked through the worker on its host, has its n8n queue workers found in the main's Compose project and checked inside their containers: ready, not ready (the database or Redis is not there), no answer, down, or running with the health check off (a warning; set `QUEUE_HEALTH_CHECK_ACTIVE=true`). The Health tab lists them by name, and their alerts name them. When they cannot be found for sure (two n8n mains in one project, no Compose project), the Health tab says why and asks for their health URLs, which still work as before. Installed workers need one more line: add `containers/json` to `-allowGET` in the worker's `docker-compose.yml` and run `docker compose up -d` there; the worker keeps its pairing. To check the queue workers, their containers must be allowed in `-allowPOST` too. `docker compose exec worker node dist/probe-cli.js` shows what the worker sees on its host.
- **Unknown health when nothing checks an instance.** An instance checked by a worker on its host shows its health as Unknown while that worker is offline, none is assigned, or the worker has not reported a check in time, and after the worker comes back or the server restarts until the next check arrives. Beside Unknown is the last known health and when it was read, in the instance list, on the instance's page and on the Overview, and Needs attention lists the instance as a check that could not run with the reason; the last known health is no longer shown as the current health or counted as healthy. A check that was not collected also reads Unknown, with its reason, and keeps the last known health from the check before it. The agents' `instances` and `queues` answers (REST and MCP) say `health: "unknown"` with `lastKnownHealth`, `lastKnownAt` and `unknownReason`. Down and other health alerts stay as they were until a check arrives, and a check the worker started before it went offline no longer counts.
- **Alert when a worker stops reporting.** When a worker that checks instances goes offline, Telegram says so once with the instances whose health is now unknown (at most ten names), and once more when it is back online. It follows the health alerts switch, and the instance's topic when the worker checks one instance. A worker that is revoked or removed ends its alert without a message.

### Changed

- **Queue worker, not worker, for n8n's queue processes.** The alerts "Queue worker down on …" and "Queue worker back on …", the health alerts switch ("Instance or queue worker down, queue backlog"), the instance's health, its Health tab and its "Queue worker health URLs" field now say Queue worker, so Worker means only the n8n-ops worker on the host.
- Worker offline and No worker beside an instance now say that its health is unknown, instead of that the health shown is not updated.

## [0.2.0] - 2026-10-27

### Added

- **Backup destinations.** Backups can go to several places at once: S3-compatible storage, a folder on the host (mapped to `/backups` in the server container), SFTP and WebDAV (HTTPS). Every copy is read back, or checked by the service, against the archive's size and SHA-256 before it counts. Each destination is tested before it is saved, has its own daily, weekly and monthly retention, can be the default and can be turned off. A stored password or SSH key reads Stored, with Replace and Remove, and "Removed when you save" until the removal is saved. Settings → Backup Destinations.
- **Destinations per instance.** Each instance backs up to the default destinations, following them as they change, or to the ones chosen on its page. The nightly backup of the n8n-ops database has its own choice. An instance left with no destination says "Choose a destination first" beside its Run now button.
- **Object Lock for S3.** An S3 destination can lock every archive it writes for a number of days (Compliance or Governance mode), so nobody can delete it early, not even with its keys. Retention removes an archive only after its lock ends.
- **Telegram forum topics.** In a group with topics, alerts can go to a topic per client: Settings → Telegram has a default topic, a topic for agent access requests, and an ordered list of routes by instance, workflow name (a pattern) or workflow tag; the first route that matches wins. Health and backup alerts follow the instance routes. The same error in two topics is two messages, and later problems edit the message in their own topic. If a topic is deleted or closed, the alert goes to General with a line that says so, and the test message tells you. Tags are read with the workflow list, so a tag changed in n8n routes after the next workflow sync.
- Alerts and the Overview now say which destination a failed or overdue backup is about. The history of each backup shows every copy: where it is, whether it was written, and why not.
- **Undo for problem actions.** Mark resolved, Mute 24 h, Reopen and Unmute still act at once, and their message now offers Undo for ten seconds, longer while the pointer or the keyboard is on it. Undo puts back exactly what the action changed, the regression mark and the mute end included. When the problem changed after the action (from another tab, a new failure, a problem merged into it or a mute that ended), it says "Already changed" and changes nothing. If Undo cannot reach the server, the message says why and offers Retry; if the list cannot refresh after it, the message offers Refresh. Each action and each Undo is in the audit log, saved together with the change.
- **Unmute.** A muted problem has an Unmute button where Mute was. It ends the mute and keeps the regression mark.
- **Changed and Reset in Settings.** A setting that differs from its default is marked Changed and offers "Reset to default (60)" under its description. Addresses and server names offer Clear instead. The Public URL says when it comes from `N8N_OPS_PUBLIC_URL`, and Reset to the environment value hands it back to the variable.
- **A Sort button on every list, at every size.** Problems, Workflows, Instances, Backups, Agent Access and the Problems tab of an instance have one Sort button, beside the search or at the end of the line under the filters. It opens a small menu: Sort by (Default order or a column) and Order, worded for the column ("Newest first", "Most first", "A to Z"). A choice applies at once and the menu stays open. The button and the column headers always show the same order, and a dot on the button means the list is not in its default order. It replaces the "Sort by" drop-down that phones and lists beside an open item had.
- **Needs attention on every page.** A bell in the top bar counts everything that needs a decision: red when something fails (a new problem or regression, an instance down, a backup that failed), amber for warnings only (an instance that needs a look, a late or partly failed backup, an agent waiting for access, an offline worker); "99+" above 99, with the full number read out by screen readers. A grey dot means a check could not run while nothing else is known to need you. The bell opens the same list as the Overview, under the bell on a wide screen and as a sheet on a phone, and closes with Escape, Back or a click beside it. Each row opens its item, and carries its action: Approve for an access request, Run now for a backup, Resolve and Mute 24 h with Undo for a problem. On a phone the Undo message can be used while the sheet is open, with Tab and screen readers too. The list refreshes every 30 seconds on every page, pauses while the browser tab is hidden, and keeps what it showed when a check fails or does not answer in time, saying which one, with Try again; the other checks still show. A move from the list that would drop unsaved changes asks first, and Stay keeps the list open.
- **Date format and Time format.** Settings → General chooses how dates and times are written, in the console, the emails and Telegram. Date format: Browser (the order of the browser's language, the default), DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD or DD.MM.YYYY. Time format: 24-hour (the default), 12-hour or Browser (the 12- or 24-hour clock of the browser's language). Browser takes only the order or the clock from the language: dates and times keep the Gregorian calendar and the digits 0-9, and the 12-hour clock says AM or PM. An example under each field shows the current time in your choice before you save, and a saved choice shows at once.
- **Values shown only in a tooltip can be read without a mouse.** The exact time behind "3 min ago" and behind a date in a list, "Latest is …" beside an old n8n version, the instances a duplicate workflow is on and the runs behind an error rate show on keyboard focus and on a tap on a touch screen. A tap shows them for a few seconds and does not open the row they are in. Inside a link, such as a figure on the Overview or a row in Needs attention, the value shows while the link has the keyboard focus, screen readers read it with the link's name, and a tap follows the link.
- **Sign-in security.** Settings → Sign-in security sets when a browser session ends: after a time without activity (60 minutes by default, can be off), a maximum length from sign-in whatever the activity (12 hours by default), and a time unused, such as after the browser was closed (24 hours by default). Typing, clicking, the mouse wheel and touch count as activity; pages that refresh by themselves do not. A minute before an idle sign-out the page asks whether you are still there, and input in another tab counts; five minutes before the maximum length it says so. After a sign-out the sign-in page says why and brings you back to the page you were on. Changes apply to sessions already open. Agents and API tokens are not affected.
- **Health from inside the container.** When an instance is checked through the worker on its host and its container name is set, the worker reads health, readiness, metrics, the execution mode and the version inside the main container, so nothing has to be reachable from outside the host and `/metrics` can be closed to the internet. Queue mode is then found by the worker, and the edit dialog shows it instead of a switch. If the socket proxy does not allow commands in the main, the worker checks over the network and the Health tab says what to add. A stopped or paused main is down; a check that could not run says Not collected instead of showing the last result.
- **Queue metrics without a URL.** An instance in queue mode reads its queue from `/metrics` of its base URL, from the server or through the worker on the host, as it checks health. The Metrics URL is now optional, for metrics served somewhere else. When n8n answers 404 there, the Health tab says that metrics are off and which settings turn them on; through a worker, this needs a worker of this release.
- **Where health is checked from.** A tag beside the name of each instance, in the list and on its page, says how its health is checked: a globe and Direct when the n8n-ops server checks it over the web, a container and Via with the worker's name when the worker on the n8n host does. Worker offline (amber) and No worker (red) say that the health shown is not being updated. The Overview tab says the same under its status line, and both say when the result shown still comes from the other path after the setting changed.
- The workflow IDs and the key of an access request, the prefix of a token made by hand and the location of a backup destination copy on a click, like other IDs.
- The end-to-end tests check every main page for accessibility problems (axe) on a wide screen and a phone, in light and dark and in both designs; a serious or critical finding fails the build.

### Changed

- A browser session no longer lasts seven days and stays open while a page is open. It now follows Settings → Sign-in security; on upgrade, a session signed in more than 12 hours earlier ends once.
- **Backup Storage became Backup Destinations.** On upgrade, the S3 storage becomes the first destination with every archive written so far. Retention moves from the instances to the destinations: the S3 destination keeps, for each of daily, weekly and monthly, the largest number any instance kept, so no archive is removed earlier than before; the previous values are in the audit log. Lower them on the destination if you want to.
- The worker now sends the encrypted archive to the n8n-ops server, which writes the copies; the archive stays encrypted with your public key all the way. Workers already installed keep working without an update.
- The production `docker-compose.yml` maps `./backups` to `/backups` for folder destinations. Add the line to an existing compose file to use them.
- The setup's last step adds the first backup destination (S3 or the folder) instead of S3 storage.
- **The page of an instance has tabs:** Overview, Problems, Health, Backups, Access and Settings. The Overview shows on one screen whether the instance is fine: its health checks in one line, open problems, workflows, executions and the last backup run, and the first three of its open problems, those that need a look first. Each tab has its own address (`?tab=health`), so a link, a reload, Back and Forward open that tab, and an address with a tab that does not exist is corrected to the Overview; an instance opened from the list starts on its Overview. The open tab is named in the browser tab and at the end of the trail in the top bar ("Instances › n8n-1 › Health"). The tabs stay at the top while the instance scrolls, and a tab opened from there starts right under them. Edits on several tabs are kept while switching and saved together, and a tab with unsaved changes is marked. Export credentials and Remove moved into the menu beside Edit. The open problems are listed as items, so nothing scrolls sideways. The tabs share the full width; in a narrow pane each shows its icon over its name, so all six fit. On a phone they are a bar at the bottom of the sheet, like the app's own tab bar.
- On a phone or a small tablet, the save bar of a page opened as a sheet (an instance, for example) shows inside the sheet, where it can be reached.
- **The page of a problem has tabs too:** Overview, Input, Occurrences and Same error (only when other workflows have the same error). The Overview shows the failures, when it was first and last seen, where in the workflow it broke and which run failed last. The runs are listed as items, and Merge into… moved into the menu beside Open in n8n. Its tabs work as the instance's do: their own address, named in the browser tab and the trail, at the top while it scrolls. A problem opened from the list starts on its Overview and keeps the list's filters, and closing it leaves the list's address without the tab.
- On a phone, an item opened from a list (an instance, a problem, a backup) opens in a sheet of four fifths of the screen whatever it holds, so it no longer changes size as you switch tabs. On a small tablet, where it opens as a dialog, the dialog keeps nine tenths of the screen's height for the same reason.
- **Choices in forms open the same list as the filters:** Worker, Check health and metrics, the workflow to restore, Restore into, Merge into, the instance to move a workflow to, the kind of a token, the lock mode and the weekly report day. A list of more than ten choices has a search, in which an underscore matches a space ("nightly sync" finds Nightly_sync). A long choice is cut short instead of making the list scroll sideways, and a short list gets more height before it scrolls.
- On a touch screen, opening a dialog or a list with a search no longer brings up the keyboard over it: a list opens on its chosen choice, and a tap on the search field still searches.
- **The phone search is a window of its own.** While it is open the page behind it cannot be reached, Tab stays inside it, and Escape, Cancel or Back close it and put the focus back on the Search button. It looks the same.
- A menu (More actions, the account menu) closes when the page or the pane under it scrolls, instead of staying where its button was. In the Compact design its items have a little more room.
- The Settings menu beside the sidebar is a menu for screen readers, and it closes when the window changes size.
- **Typed work is not dropped without asking.** A dialog you typed in (Add or Edit instance, a backup destination, Add a Worker, New Token, Restore, Move) asks "Discard your changes?" before Cancel, Close, Escape, Back or pulling the phone sheet down throws them away. Keep editing is the first choice, so Enter keeps the work; after a save the dialog closes without asking.
- **What needs a look comes first.** Until you pick another order, Problems, the open problems of an instance and the problems in the search list regressions first, then problems first seen in the last 24 hours, then the rest, each by when they were last seen. This is the Status column from high to low, so a first click on Status turns it around. Instances list those down first, then those that need a look, then by name; Backups those backed up nowhere or whose last run failed, then late or partly failed ones; Workers the offline ones; Agent Access the requests waiting for you, then active ones. On Instances and Agent Access this is the Status column from high to low, so choosing it shows no dot and a first click on Status turns it around. Default order in the Sort menu brings this order back.
- **Filters stay in reach.** The filter bar of a list stays at the top while the list scrolls, at every window width, and a new filter or search starts the list at its first row. If you scroll the list while its new rows load, it stays where you put it. On a phone the Instance filter shows beside the search instead of behind a Filters button.
- The searches of Problems and Workflows wait until you pause typing before they ask the server and change the address; what you type shows at once. Clear filters also drops a search you are still typing.
- A cut-off instance name, backup destination, workflow name, node name or trigger shows in full when you hover over it. A column header shows its sort arrow faintly when it has the keyboard focus, as it does under the pointer.
- **On a phone, the Needs attention bell replaces the red "N problems" pill** in the top bar.
- **Needs attention on the Overview grows to a set height, then scrolls inside**, with a line that counts the items ("12 items. Scroll the list for the rest") and a fade while more is below, so the panels under it stay in reach. The Overview draws its figures and panels before its first answer instead of jumping into place, and the Need attention figure is red or amber like the bell. Failed backups are listed, not only late ones, and so are instances whose health was never checked or whose failures could not be read.
- **The phone More sheet leaves the tab bar usable:** a tab goes straight to its page while the sheet is open, and closing the sheet puts the focus back on More. A page chosen in the sheet that would drop unsaved changes asks first, and Stay keeps the sheet open. Widening the window past the phone width closes the sheet. The dot on More says what it counts to screen readers and is red when one of those counts is.
- On Backups beside an open item (1000 to 1280px wide), the three figures stay in one row instead of stacking above the list.
- **Settings keeps your changes across its sections.** Moving to another section no longer asks: each section with unsaved changes gets a dot in the list (and "(unsaved)" in the picker on narrow screens), one save bar counts every change, Save changes saves every changed section and Discard drops them all. Leaving Settings still asks.

- When the server cannot sign in to PostgreSQL or reach it at startup, it says why in one line and what to do, instead of a stack trace. A refused password explains that changing it in `.env` does not change it in an existing database, and how to set it.
- The production `docker-compose.yml` shows the server's health check, so tools that read the compose file show it too. The check itself is unchanged.
- Adding a worker is one file: Add a Worker gives a `docker-compose.yml` with the server address and the pairing token in it, to save in an empty folder on the n8n host and start with `docker compose up -d`. There are no commands to run and no `.env` or Docker group to fill in: the worker image hands `./data` to its user and, without the socket proxy, joins the Docker socket's group by itself, and the socket proxy runs as root with no capabilities to open the socket. The worker image is pinned to the server's version instead of `latest`.
- **Messages name what they are about.** "Problem resolved: Sync orders", "Access approved for claude on n8n-1", "Checked n8n-1 now", "Backup of n8n-1 started". When something fails, the message says what and why: "Could not resolve Sync orders: Not found." instead of only "Not found.".
- **Deny on an access request asks first**, since the decision is final: the question names the agent and the instance, and Cancel leaves the request waiting.
- Buttons that send a request show a spinning ring with what they are doing ("Checking…"). The buttons that act on one click (Run now, Check now, Test, Approve, Mark resolved, Mute, Reopen, Refresh now) then show "Done" or "Failed" for a moment before their label comes back.
- **Settings checks what you typed before it saves.** Every changed field is checked first, and nothing is sent while one fails: the first one opens its section, takes the focus and says under it what is wrong, and the message names it ("Recipients: "bob" is not an email address", or "2 fields need a valid value, starting with Recipients"). The server checks the same and names a refused field in words, instead of "dailyTime: use HH:MM".
- **Recipients and Telegram approvers are lists of chips.** Enter, a comma or a pasted list adds them (a paste replaces the selected text), × or Backspace removes one, and a value is never added twice. Text typed but not yet added already counts as an unsaved change, and Save adds it. A value that is not an email address, or not a Telegram user ID or @username, is shown in red with the reason.
- **Send test message and Send test email use the values on screen,** saved or not, and show the result beside the button: Accepted (with who received the email) or what failed and what to check, with the time. After a change, including a password or bot token replaced or removed and saved, the line says the values changed since the test. A test saves nothing, and the stored SMTP password is used only for the server and user it was stored for; for another one, type the password to test.
- Daily report time, Weekly report day and time, and Who may approve in Telegram stay in place but greyed out, with the reason, while the switch they depend on is off.
- In the Compact design, setting choices (Design, the kind of a backup destination, what an API key can do) are a segmented control instead of filter chips.
- **Dates in the console are numbers, written one way.** Every date and time follows the Date format and Time format in the app's time zone, without month names: a list shows the time for today, day and month earlier this year ("16/10") and the whole date before ("16/10/2025"), and a full time reads "16/10/2026, 14:05:09". The daily backup time on Backups follows the Time format ("2:00 AM" on the 12-hour clock); it is still typed and stored as 24-hour HH:MM. A pending access request counts down to its end ("Expires without a decision in 25 min"), and an approved one says how long it has left.
- **Dates in emails and Telegram follow the same formats** and carry the time zone's short name after a time ("20/10/2026 13:00 CEST"). With Browser, which an email cannot ask, they are day/month/year and the 24-hour clock. The daily and weekly reports give the exact window they count ("From 22/10/2026 06:00 to 23/10/2026 06:00 CEST"), with the zone at both ends when daylight saving changed in between, and count only what happened in that window: a failure or a health incident that arrives while the report is being made goes into the next one. An access request on Telegram gives the date with each time.
- **Animations no longer turn off when the system asks for reduced motion.** Sheets, dialogs, menus, the Regular design's counting figures and the pulse on a down instance move as designed, whatever the operating system's setting.
- A value that copies on a click (an execution ID, a base URL) shows its copy icon only under the mouse, and its tooltip says "Click to copy". Over plain HTTP, where browsers do not allow copying, it says "Copying needs HTTPS. Select the text and copy it instead." In the Compact design the value turns light blue under the mouse.
- In the top bar the page's own buttons come after the search.
- On a screen 600px high or less, a list and its open item stay side by side, but the page scrolls them as one instead of each on its own. A change of height, such as an on-screen keyboard opening, keeps the open item and what is typed in it. There too, another tab of the item starts right under its tabs, a new filter starts the list at its first row, and Back returns to where you were reading, also when you had scrolled on a taller window.
- On a phone, figures go two to a line, however wide the phone, and an odd last one takes the whole line, also the three of a problem.
- Status tags and grey text are a little darker in light themes, so they stay readable on a selected row.
- **The Compact design is closer to its type scale.** Dialog and sheet titles are bold, the page title in the top bar is a little larger, and on a phone the page title is larger, a step smaller on screens 380px wide or less, with the page's main button beside it shown without its icon. A message at the bottom of the screen has a thin border, smaller corners and smaller text. On a phone a sheet casts its shadow up over the page. Figures fit more to a row, scrollbars are grey, and the dot of the n8n-ops mark is no longer green, since colour stands for status. IDs and other values in bold use the code font's own bold letters.

### Fixed

- A health check that started earlier could overwrite one that started later, and a check under way when the way an instance is checked changed could still be applied. Each check now carries its number and the settings it was made for, and a stale one is dropped.
- A server restart reset the timer of a queue backlog, and metrics that could not be read cleared a backlog alert with a "cleared" message while the queue was still full. The backlog now changes only on a measurement and survives a restart.
- An instance that collects health through a worker stopped being checked for good when its earlier worker was revoked or replaced with a check still waiting for it. Only a check waiting for the worker assigned now holds the next one back.
- A worker that could not write its data folder used up its pairing token, then sent the spent token every five seconds and repeated "The pairing token is wrong, used or expired" with no other reason. It now checks the folder first, keeps the token and says once why it does not pair yet. A token the server refused, or one already used, is not sent again: the log says once to create a new one. If saving still fails after pairing, it says so.
- The workflow list of an instance on an older n8n (2.30, for example) stayed empty: its executions API refused the 30-day filter that the workflow sync sent. The sync now reads the recent executions without the filter there.
- The run and error counts of the last 30 days stopped at 10,000 executions per instance. The workflow sync now reads every execution n8n still keeps.
- **Sorting and the count on Problems cover every problem, not only the 200 most recently seen.** A sort by Failures, for example, now puts the problem with the most failures first however long ago it was seen. Above 200, the line under the filters reads "200 of 1,240 open problems" instead of "200 open problems", and a note under the list says it shows the first 200 in that order. A blank workflow name or error comes last in either direction. When the list in a new order cannot be loaded, the rows, the column headers and the Sort button stay in the order the rows are in, and a line says the list could not be loaded, with Try again; an order is kept while you move between pages only once its list has loaded. The search and the Problems tab of an instance count every problem they find too, and that tab also says when its list could not be loaded or refreshed. The API for agents is unchanged.
- Clicking a tab (Connected Agents, for example) no longer leaves a focus ring around it, cut off at the top and bottom. The ring still shows, whole, when the tabs are used with the keyboard.
- **The SMTP password is no longer sent to a new SMTP server.** Changing the SMTP server, port or user in Settings → Email Reports now needs the password again; before, the stored password was used to sign in to whatever server was entered next.
- A new problem or regression no longer goes missing from Needs attention when more than 50 other open problems were seen after it. The count and the colour now cover every item, also those past the 50 listed.
- The Overview no longer says "Nothing needs you right now." while a check could not run (an instance never checked, its failures not read): it lists those checks, or says "Some checks could not run."
- What is typed in Edit instance is no longer replaced by the stored values when the instance refreshes behind the dialog (every 15 seconds, or on coming back to the window).
- "Leave without saving?" now starts on Stay, so pressing Enter keeps your changes, and it no longer adds a step to the browser's history.
- Log out with unsaved changes asks first, before the session ends. If signing out fails, it says "Could not sign out. Try again in a moment." and the changes stay.
- When your session ends on an open page, the page now goes to sign-in and brings you back to it afterwards, instead of showing errors.
- When one area of a save fails and another is saved, the message now names what failed and why; before, the success message could replace it. The failed area keeps its changes.
- After Add instance or Merge, Back goes to the page the dialog was opened on in one step, instead of first returning to an empty step of the closed dialog.
- The line under a row of tabs that scrolls sideways now runs to its end at any scroll position.
- **A failed refresh no longer empties the page.** When a list, an open item or a Settings form cannot be refreshed (during a server restart, for example), what was loaded stays on screen and the line under the title reads "Could not refresh · Updated 4 min ago" in amber, with Try again. Settings sections, the backup destinations and the Connect an Agent page say it beside their title. When a filter on Problems or Workflows cannot be loaded, the rows shown before stay and the line under the filters reads "Could not load muted problems; showing the previous list", with Try again. Each line clears with the next good answer. Before, the rows or the form were replaced by an error until then.
- The audit log keeps every entry already loaded when older entries fail to load, and says so at the end of the list with Try again. It waits for Try again even when the list refreshes, for example on coming back to the window, and Try again keeps the keyboard focus while it loads. Before, the whole log was replaced by an error, after asking twice more on its own.
- Show full execution on a problem says why the execution could not be loaded, instead of showing the error as JSON. Closing the window while it loads no longer opens it again when the answer arrives.
- The search still finds the instances already loaded when the last refresh of the instance list failed, instead of saying it could not search them.
- `scripts/verify.sh --changed` (and the CI of pull requests) no longer builds the web app twice at once when a file at the root such as `CHANGELOG.md` changed, which could fail the build at random.
- Add a Worker accepts any name up to 60 characters, such as "Docker Office". Before, a name with a space was refused with a technical pattern message. A refused value in the dialog is now explained in words.
- The commands Add a Worker gave wrote `.env` with `cat >`, which replaced any `.env` already in that folder.
- **Selecting text in a list row works as expected.** Dragging over a row, double-clicking a word or Shift-clicking selects its text without opening the row, also on rows that are links (the Overview, Same Error). A plain click opens the row even while text is still selected, and Enter or Space on a row opens it while text is selected elsewhere on the page; before, both did nothing.
- The search returns to its narrow size, and the page's buttons come back, after Escape or Tab out of an empty search; before, it stayed wide until a click elsewhere. The next search starts on All again. When "Leave without saving?" keeps the page after a result was chosen, the search keeps what was typed, also on a phone, where the next search opens with it; it is cleared only once the result's page has opened. A workflow or an instance chosen in the search is ringed for a moment in its list, as a setting is.
- The search can be used without a mouse: "N found · Open in …" on a result type is reached with the arrow keys like the results (a type still starts on its first result), Left and Right move between the result types, and "/" opens the search on a phone with a keyboard.
- **Sign-in no longer hangs when n8n-ops cannot be reached.** The button stays on "Signing in…" only while it waits, then says "Could not reach n8n-ops. Check your connection and try again." and keeps what was typed. The same holds for the setup steps and Change password. A two-factor code that got no answer stays, with Try again; a wrong code is cleared. When setup made the account but could not sign in, trying again only signs in. A wrong password says "Invalid username or password." Show password keeps the cursor in the field, and the Caps Lock note is read out with the field.
- Change password keeps what was typed when the change fails; before, the fields were emptied at once.
- A button that cannot be used now shows the not-allowed pointer and its tip. A click on a disabled button inside a row no longer opens the row.
- A message in the corner now also waits while the keyboard is on it, not only the pointer, and then stays for the rest of its time (at least 1.5 seconds) instead of four seconds more. A message caught while it fades comes back, and a message that replaces one under the pointer waits too.
- When a proxy in front of n8n-ops answers instead of it, a failure now says "n8n-ops did not answer. Try again in a moment." (or which error the server answered with) instead of a code such as `http_502`.
- A double click on Run now starts one backup, not two. The same holds for Check now, Test, Mark resolved, Approve and the other buttons that act on one click.
- **A Public URL from `N8N_OPS_PUBLIC_URL` is no longer written to the database by an unrelated save.** Before, saving General (only the design, for example) stored it, and a later change of the variable had no effect. An address stored that way before shows "Replaces …, set by N8N_OPS_PUBLIC_URL" with Reset to the environment value.
- Email recipients and Telegram approvers are checked when saved: "bob" or "bob@exmaple" is refused, by name, instead of being saved without a word.
- A Settings section opened from another one starts at its top, instead of at the scroll position of the one before.
- Back and Forward bring the list beside an open item, and the item itself, back to where they were scrolled, not only the page. This holds also for an item open as a dialog on a small tablet or as a sheet on a phone, for each of its tabs. A place left at its top without scrolling is brought back to its top too.
- Clicking Settings in the sidebar while a Settings section is open no longer adds a step that Back has to undo.
- Dialogs keep 16px from the edges of the screen on small tablets; a wide one, such as an instance opened from the list, touched them.
- On a phone, menus and lists of choices open between the top bar and the tab bar instead of over them.
- A second finger on a phone sheet while pulling it no longer moves or closes it; it springs back and waits until every finger is lifted.
- **A workflow with no runs in 30 days shows a grey "-" for its errors instead of "0%",** with "No runs in the last 30 days" on hover. A backup without a known size or count shows the same "-".
- Counts read right everywhere: "1 workflow", "1 entry", "1 of 1 instance", "1 needs a look", and a kind with none is left out ("12 workflows · 3 inactive", not "· 0 duplicated"; "2 need a look", not "0 down, 2 need a look"). Backup sizes drop trailing zeros ("1 MB", "1.5 MB", not "1.0 MB"). "Ago" times are rounded ("1 h 40 min" reads "2 h ago"), and an age just under a year reads "1 year ago" instead of "0 years ago".
- A dark theme no longer flashes white while a page loads: the theme is applied before anything is drawn. A browser that blocks site data gets the system's theme.
- Double-clicking the Filters or Sort button, or Advanced on Connected Agents, no longer selects its text. Advanced opens and closes with the keyboard as a standard fold.
- The account button's name for screen readers now includes the user name it shows.

### Security

- Nodemailer is updated to 10.2.1, which fixes three ways its address parser could misread an unusual sender or recipient address (GHSA-85x2-q946-cp5h, GHSA-m943-m63m-w62w, GHSA-8c8m-p3m8-cjg8). In n8n-ops these addresses come only from Settings → Email, which only a signed-in user can change; agents and API tokens cannot.

## [0.1.0] - 2026-10-22

### Added

- **Failure monitoring.** Reads every instance's failed executions and groups them into problems, one per workflow, node and exact error, with the full stored execution. Regressions, auto-resolve, mute, merge and retention; the first sync is silent.
- **Alerts and reports.** One Telegram alert per problem, with Resolved and Mute buttons; several workflows failing with the same error become one message, which later problems edit instead of repeating. Alerts when an instance or a queue worker goes down and when it recovers, when a queue backlog lasts, and when a backup fails or is overdue. Daily and weekly email reports that read on phones, in dark mode and in Outlook.
- **Health.** Main processes, queue workers and queue backlog, checked from n8n-ops or from inside the n8n host.
- **Instances.** Registration with a connection test. The API key's scopes, read from n8n 2.14 and later or declared on older versions, turn features on and off. A version check against the latest n8n release.
- **Backups.** Workflows and credential secrets, encrypted with your public key before they leave the n8n host, verified in S3-compatible storage, scheduled per instance with daily, weekly and monthly retention, and a nightly backup of the n8n-ops database. Restore of a single workflow with its credentials, and export of decrypted credentials as an encrypted file.
- **Workflows and consolidation.** A map of every workflow on every instance with run counts, duplicates and almost unused instances. Moving a workflow with its credentials after a review of what will change for webhooks and Execute Workflow nodes.
- **Agents.** A read-only MCP server at `/mcp` and a REST API at `/api/v1`, with workflow search by name, ID, webhook path and tag. Agents connect by approval: an MCP client needs only the address, a script gets a link and a code, and agents that run commands install the n8n-ops skill with one sentence (it needs only Node, Windows PowerShell, or sh and curl). Short-lived access tokens, refresh tokens replaced on every use, and Disconnect on the Connected Agents page.
- **Temporary access to n8n instances.** An agent asks for scopes, optional workflows and minutes; you approve in Telegram, by email or on the Agent Access page. The agent then uses the n8n API through n8n-ops, which checks every call against the scopes n8n declares and records it. Access ends on time, on release or on revoke.
- **Worker** for n8n Docker hosts, for credential secrets in backups, moves with credentials and health from inside the host. It pairs with a one-time token and only makes outbound requests. Workers → Add worker gives a ready compose file in which a Docker socket proxy allows only `exec` in the listed n8n containers.
- **Sign-in and audit.** Username, password and mandatory two-factor authentication; a first-run setup for the account, two-factor, the backup key pair, Telegram and storage; a `reset-password` command for the server container. An audit log of sign-ins, changes and agent reads.
- **Interface.** Live updates; two designs for the whole installation, Regular and Compact, with the same functions; light, dark or system theme; one search for pages, settings, problems, instances and workflows; lists beside a reading pane; layouts for phones.
- **Deployment.** Images on GHCR (`n8n-ops` and `n8n-ops-worker`) and a production `docker-compose.yml` behind Traefik that asks only for the version, the domain and the database password. Every container runs as a non-root user with no extra privileges.

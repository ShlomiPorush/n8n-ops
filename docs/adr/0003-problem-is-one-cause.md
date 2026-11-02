---
status: accepted
---

# A Problem is one cause: what the failing node talked to and what went wrong there

Supersedes [0001](0001-problem-is-one-error-across-workflows.md). Not built yet: the rules that read the cause exist (`apps/server/src/services/cause.ts`), and grouping, alerts and the interface switch to them in a later change, which also regroups the Problems recorded before.

0001 made a Problem one exact error text wherever it happens. n8n words many errors the same way for every service it calls: its HTTP Request node reports "Bad request - please check your parameters" for any 400 and "The resource you are requesting could not be found" for any 404. In practice those texts joined unrelated faults into one Problem, such as a retired AI model and a deleted download file, and a Problem's title did not say where it broke. The stored execution already holds what tells the faults apart: the failing node's type, its URL and credential, and the answer of the service it called (n8n's error description).

A Problem becomes one **cause**, read from that data by fixed rules. No rule calls out to a service or guesses, so the same failure always gets the same cause, and an error the rules do not know keeps n8n's own words.

- The **target** is what the failing node talked to: the workflow an Execute Workflow node runs, else the host of the node's URL, else its credential, else a host named in the error when the node has no URL, else the node itself. Each target has a stable key (a workflow or credential ID with its instance, a host, a node of one workflow) and a label that may change, such as a credential renamed, without changing the key.
- The **reason** is the service's own answer when n8n kept it (plain text, the text of a JSON body, the code and message of an XML error, the title of an HTML page), with the HTTP status that n8n's message stands for; else n8n's message.
- The cause key is the target key and the reason with values that change on every failure (UUIDs, times, request IDs) replaced. An Affected workflow is a workflow at one node with one cause; when a node starts failing for another reason, that reason is an Affected workflow of its own.

## Consequences

- Failures join across workflows only when they share a target and a reason. A host joins across instances; a workflow or credential ID, and a node, never do, because n8n assigns them per instance.
- A workflow whose sub-workflow fails is its own Problem, titled after the workflow it runs and with the sub-workflow's error as its reason. n8n's link from a child execution to its parent does not prove which child made the parent fail, so the two are not joined.
- Each cause has a kind (your alert from a Stop and Error node, n8n task runner, called workflow failed, certificate, network, sign-in rejected, service error, request rejected, other) and, for errors in a fixed table, one line that says what it means.
- Merge and Split stay, for causes the rules cannot tell apart or join.
- Upgrading regroups the recorded Problems by cause. Telegram buttons on messages sent before the upgrade no longer act; links to old Problems still open.

# n8n-ops

The language of n8n-ops, an operations console for many n8n instances. This file is a glossary: it says what each word means, not how anything is built.

## Language

### Hosts and processes

**Worker**:
The n8n-ops program that runs on the Docker host of an n8n instance and works for the n8n-ops server.
_Avoid_: agent, host agent, n8n worker

**Queue worker**:
An n8n process that runs executions taken from the queue when an instance runs in queue mode. It is part of n8n, never of n8n-ops.
_Avoid_: worker, n8n worker

**Main**:
The n8n main process of an instance and the container it runs in, as n8n itself names it.
_Avoid_: main instance, primary

### Health

**Collection**:
Gathering an instance's health and queue metrics.
_Avoid_: polling

**Direct collection**:
Collection by the n8n-ops server itself, from outside over the internet, without a Worker.
_Avoid_: API collection, network collection, internet collection

**Worker collection**:
Collection by the Worker on the instance's Docker host. How the Worker reached the Main is a detail of one result, not a kind of collection.
_Avoid_: inside collection, network fallback

**Not collected**:
The result of a collection that ran but could not read the instance. It always carries the reason.
_Avoid_: failed check, error

**Down**:
The health of an instance whose Main does not answer, answers that it is not healthy, or is stopped.
_Avoid_: offline, dead

**Unknown**:
The health of an instance when there is no current knowledge of its Main: the last collection was not collected, or no collection runs, for example because its Worker is offline or none is assigned.
_Avoid_: stale, n/a

**Last known health**:
The health from the last collection that read the instance, shown beside Unknown with the time it was read. It is never shown as the current health.
_Avoid_: cached health, previous health

### Agents

**Agent**:
A program, such as an AI assistant or a script, that uses n8n-ops through MCP or REST.
_Avoid_: client, bot

**Connection**:
An Agent's standing link to n8n-ops, made when a person approves it. Each Connection is its own identity and ends when it is disconnected or unused for 90 days.
_Avoid_: grant, session, authorization

**Token**:
A secret made by hand in n8n-ops that lets a program use n8n-ops without a Connection.
_Avoid_: API key, access token

**API key**:
The key of an n8n instance that n8n-ops keeps. It is never given to an Agent.
_Avoid_: token

**Agent access**:
How Agents reach the API of n8n instances through n8n-ops: their Access requests, the Temporary access each approval gives, and the record of every Call made with it.
_Avoid_: instance access, proxy access

**Access request**:
An Agent's request to use the API of one n8n instance for a while, with a reason, scopes and a duration, which a person approves or denies.
_Avoid_: grant request, permission request

**Temporary access**:
An approved Access request while it lasts. It ends on time, when the Agent releases it, or when a person revokes it.
_Avoid_: grant, session

**Call**:
One request an Agent made to an n8n instance's API with Temporary access. n8n-ops records every Call.
_Avoid_: proxy request, access log entry

### Problems

**Problem**:
One error, known by its exact text, wherever it happens: on any instance, in any workflow. It is what alerts, and what a person resolves or mutes.
_Avoid_: incident, issue, error group, problem group

**Affected workflow**:
A workflow that a Problem hit, at one node, with its own failures, first and last seen, and its own resolved or muted state. The same workflow failing at two nodes is two Affected workflows. A Problem is resolved when all its Affected workflows are.
_Avoid_: occurrence, instance of a problem

**Regression**:
A new failure of a Problem, or of one of its Affected workflows, after it was resolved. It reopens the same Problem and never makes a new one.
_Avoid_: recurrence, new problem

**Merge**:
Joining two Problems that a person judges to be the same error into one.
_Avoid_: combine, link

**Split**:
Moving an Affected workflow out of its Problem into a Problem of its own, when the same error text has a different cause there.
_Avoid_: unmerge, detach

### Backups

**Backup run**:
One backup of an instance, or of n8n-ops itself, at one time. It ends ok, partial or failed.
_Avoid_: job, backup task

**Archive**:
The encrypted file a Backup run makes.
_Avoid_: dump, snapshot

**Destination**:
Where Copies are kept: S3-compatible storage, a mapped folder, SFTP or WebDAV.
_Avoid_: storage, target, bucket

**Copy**:
The delivery of one Archive to one Destination, with its own status. A Backup run has one Copy per Destination it backs up to.
_Avoid_: upload, replica

**Location**:
The exact place of a Destination. It never changes once set, and no two Destinations share it.
_Avoid_: place, path

**Retention**:
How many Copies a Destination keeps, daily, weekly and monthly, for each instance and separately for n8n-ops itself.
_Avoid_: rotation, cleanup

**Default destinations**:
The Destinations an instance backs up to when it has not chosen its own.
_Avoid_: global destinations

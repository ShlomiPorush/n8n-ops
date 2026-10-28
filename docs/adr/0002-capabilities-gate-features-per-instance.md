---
status: accepted
---

# Capabilities gate features per instance

Built in migration 0015. Existing instances became active with every Capability, and back up through their worker when one was assigned with the main set (otherwise through the API).

An instance used to be added in one step with an API key, and every feature then ran on it: failure polling, health, the workflow map, backups, Temporary access. An instance meant only for backups still polled executions, and a missing worker or scope showed up later as errors and alerts. Instead, the owner chooses the Capabilities of each instance when adding it, and a setup wizard asks only for what those Capabilities need (an API key with given scopes, a worker that can run a command in the main, destinations and the backup key) and checks each before the instance is activated. Until then the instance is Setup incomplete and does nothing in the background.

## Consequences

- Chosen Capabilities gate features after activation too: each background loop, page that acts on instances, manual trigger and worker job runs only for active instances with the Capability it serves. History (problems, backups, workflows as last synced) stays visible after a Capability is removed.
- Health and backup alerts are decided where they are made (`enqueueAlert`, `setCondition`) with the instance row share-locked, so an alert of a Capability being removed is either cleared by the removal or not made.
- Each setup check is stored per kind with its attempt number, server start time and a fingerprint of its own inputs (the API check: base URL and key; health: base URL and queue settings; the worker check: worker, main and queue settings; backup: how it is backed up, besides the destinations and backup key it compares). A result counts only while the instance still has those inputs, so saving one step (the access policy, the destinations) never asks again for checks it does not touch; API, health and worker results also expire after 15 minutes, and a worker check that does not end within 90 seconds has failed. Activation verifies the stored results against the locked row. A first version bound every result to one configuration revision, which made any saved step ask for every check again.
- Adding a Capability to an active instance verifies only what it adds and what that brings (Move workflows brings the map, Restore brings Backup). Removing one needs no check: its conditions end without a message, its queued jobs are deleted, and backup runs still waiting for their archive end without an alert.
- A backup through the worker fails when no worker is available instead of falling back to an API backup that silently leaves out credential secrets.
- n8n-ops needs n8n 2.14.0 or later (`GET /api/v1/discover`). The declared read or read and write access for older n8n is removed; on an older instance every Capability that uses the API is unavailable.
- A release older than this one cannot run against a database it migrated. To go back, restore n8n-ops's own database backup taken before upgrading.

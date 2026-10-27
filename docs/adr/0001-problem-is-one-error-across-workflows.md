---
status: accepted
---

# A Problem is one error across workflows and instances

Accepted; not built yet. Until it is, the code and `docs/requirements.md` (B3) still keep one Problem per instance, workflow, node and error text.

A Problem is one workflow, node and exact error text on one instance, and the same error in several workflows is joined automatically only in its Telegram message (a person can Merge Problems by hand). The person who runs n8n-ops thinks of that as one fault, so a Problem becomes one exact error text wherever it happens, on any instance and in any workflow, and the workflows it hits are its Affected workflows. Each Affected workflow can be resolved or muted on its own, because a cross-cutting fault may need a fix in each workflow, and the Problem is resolved when all of them are.

## Consequences

- A workflow that starts failing with the error of an open Problem joins it and alerts: within the configured edit window (60 minutes by default) the Problem's message is edited, after that a short new message is sent. A failure after the Problem or the workflow was resolved is a Regression of the same Problem, never a new one.
- Generic error texts, such as those of the HTTP Request node ("Bad request - please check your parameters"), join unrelated failures into one Problem. Split moves an Affected workflow out to a Problem of its own; Merge does the opposite.
- The Problems list shows a Problem that hit several workflows as one row titled by its error, which opens to its workflows. A Problem that hit one workflow keeps the workflow name as its title.

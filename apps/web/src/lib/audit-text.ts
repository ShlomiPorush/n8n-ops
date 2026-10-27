/*
 * The words an audit entry is shown in. The stored action and target stay as they were written, so older entries
 * and the API keep them; only the page shows the words of today. An action not listed here is shown as stored.
 */

const actions: Record<string, string> = {
  "Instance access requested": "Access requested",
  "Instance access approved": "Access request approved",
  "Instance access denied": "Access request denied",
  "Instance access revoked": "Access request revoked",
  "Instance access released": "Access request released",
  "API token created": "Token created",
  "API token revoked": "Token revoked",
}

export function auditAction(action: string): string {
  return actions[action] ?? action
}

/** A token's target ends with what it may do, in the words it was stored with. */
export function auditTarget(target: string): string {
  return target.replace(", may request instance access)", ", may request access to n8n instances)")
}

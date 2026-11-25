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

export function auditTarget(target: string): string {
  return target.replace(/, may request instance access\)$/, ", may request access to n8n instances)")
}

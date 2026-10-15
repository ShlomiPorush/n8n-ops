import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" })
const created = () => ts("created_at").notNull().defaultNow()
const updated = () => ts("updated_at").notNull().defaultNow()

// ---------------------------------------------------------------------------
// Better Auth (property names must match Better Auth field names)
// ---------------------------------------------------------------------------

export const user = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  username: text("username").unique(),
  displayUsername: text("display_username"),
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
  createdAt: created(),
  updatedAt: updated(),
})

export const session = pgTable("auth_session", {
  id: text("id").primaryKey(),
  expiresAt: ts("expires_at").notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: created(),
  updatedAt: updated(),
})

export const account = pgTable("auth_account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: ts("access_token_expires_at"),
  refreshTokenExpiresAt: ts("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: created(),
  updatedAt: updated(),
})

export const verification = pgTable("auth_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: created(),
  updatedAt: updated(),
})

export const twoFactor = pgTable(
  "auth_two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: ts("locked_until"),
  },
  (t) => [index("auth_two_factor_secret_idx").on(t.secret), index("auth_two_factor_user_idx").on(t.userId)],
)

// ---------------------------------------------------------------------------
// Settings and audit
// ---------------------------------------------------------------------------

/** One row per settings section (alerts, telegram, email, storage, keys, defaults). Secrets inside are encrypted. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updated(),
})

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: ts("at").notNull().defaultNow(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    target: text("target").notNull().default(""),
    via: text("via").notNull(),
    details: jsonb("details"),
  },
  (t) => [index("audit_log_at_idx").on(t.at)],
)

export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: text("kind").$type<"mcp" | "rest">().notNull(),
  prefix: text("prefix").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  /** May ask for temporary access to n8n instances (needs human approval each time). */
  canRequestAccess: boolean("can_request_access").notNull().default(false),
  createdAt: created(),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
})

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

export const workers = pgTable("workers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").unique(),
  version: text("version"),
  lastSeenAt: ts("last_seen_at"),
  createdAt: created(),
  revokedAt: ts("revoked_at"),
})

export const pairingTokens = pgTable("worker_pairing_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: created(),
})

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

export type Health = "ok" | "warn" | "down" | "unknown"
export type KeyAccess = "read" | "write"
export type CollectionMode = "direct" | "worker"

export const instances = pgTable("instances", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  baseUrl: text("base_url").notNull(),
  apiKeyEnc: text("api_key_enc").notNull(),
  /** Container name on the Docker host, used by the worker for docker exec. */
  containerName: text("container_name"),
  workerId: uuid("worker_id").references(() => workers.id, { onDelete: "set null" }),
  queueMode: boolean("queue_mode").notNull().default(false),
  /** URL of the main process /metrics endpoint (queue instance). */
  metricsUrl: text("metrics_url"),
  /** Health URLs of queue workers. */
  workerHealthUrls: jsonb("worker_health_urls").$type<string[]>().notNull().default([]),
  /** How health and metrics are collected: directly from the server, or through the host worker. */
  collection: text("collection").$type<CollectionMode>().notNull().default("direct"),
  version: text("version"),
  scopes: jsonb("scopes").$type<string[] | null>(),
  scopesSource: text("scopes_source").$type<"discovered" | "declared">().notNull().default("discovered"),
  declaredAccess: text("declared_access").$type<KeyAccess>(),
  scopesCheckedAt: ts("scopes_checked_at"),
  health: text("health").$type<Health>().notNull().default("unknown"),
  healthDetail: jsonb("health_detail").$type<Record<string, unknown>>(),
  healthCheckedAt: ts("health_checked_at"),
  lastPollAt: ts("last_poll_at"),
  lastPollError: text("last_poll_error"),
  firstSyncDone: boolean("first_sync_done").notNull().default(false),
  /** Highest execution id already processed. */
  executionCursor: text("execution_cursor"),
  overrides: jsonb("overrides").$type<Record<string, unknown>>().notNull().default({}),
  /** Whether agents may ask for temporary access, and the most they may ever be granted. */
  agentAccess: jsonb("agent_access").$type<AgentAccessPolicy>().notNull().default({ enabled: false, scopes: [] }),
  createdAt: created(),
  updatedAt: updated(),
})

export type AgentAccessPolicy = { enabled: boolean; scopes: string[] }

// ---------------------------------------------------------------------------
// Problems and failures
// ---------------------------------------------------------------------------

export type ProblemStatus = "open" | "resolved" | "muted"

export const problems = pgTable(
  "problems",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull(),
    workflowName: text("workflow_name").notNull(),
    nodeName: text("node_name").notNull(),
    errorMessage: text("error_message").notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status").$type<ProblemStatus>().notNull().default("open"),
    mutedUntil: ts("muted_until"),
    regression: boolean("regression").notNull().default(false),
    count: integer("count").notNull().default(0),
    firstSeen: ts("first_seen").notNull(),
    lastSeen: ts("last_seen").notNull(),
    resolvedAt: ts("resolved_at"),
    /** When set, this problem was merged into another one by the operator. */
    mergedInto: uuid("merged_into"),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("problems_fingerprint_idx").on(t.fingerprint),
    index("problems_status_idx").on(t.status),
    index("problems_instance_idx").on(t.instanceId),
  ],
)

export const failures = pgTable(
  "failures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    problemId: uuid("problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    executionId: text("execution_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    mode: text("mode"),
    startedAt: ts("started_at"),
    stoppedAt: ts("stopped_at"),
    error: jsonb("error"),
    nodeInput: jsonb("node_input"),
    /** The full execution as returned by n8n (searchable JSONB). */
    data: jsonb("data"),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("failures_execution_idx").on(t.instanceId, t.executionId),
    index("failures_problem_idx").on(t.problemId),
    index("failures_created_idx").on(t.createdAt),
  ],
)

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export type AlertKind = "problem" | "health" | "backup" | "test"

export const alertOutbox = pgTable(
  "alert_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<AlertKind>().notNull(),
    /** Problems with the same group key inside the grouping window go out as one message. */
    groupKey: text("group_key"),
    problemId: uuid("problem_id"),
    text: text("text").notNull(),
    status: text("status").$type<"pending" | "sent" | "merged" | "failed">().notNull().default("pending"),
    sendAfter: ts("send_after").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    telegramMessageId: integer("telegram_message_id"),
    createdAt: created(),
    sentAt: ts("sent_at"),
  },
  (t) => [index("alert_outbox_pending_idx").on(t.status, t.sendAfter)],
)

/** A sent Telegram message that later problems with the same error edit instead of sending a new message. */
export const alertGroups = pgTable("alert_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupKey: text("group_key").notNull(),
  telegramMessageId: integer("telegram_message_id").notNull(),
  problemIds: jsonb("problem_ids").$type<string[]>().notNull().default([]),
  createdAt: created(),
})

/** Ongoing health and backup conditions, so each alerts once when it starts. */
export const alertState = pgTable("alert_state", {
  key: text("key").primaryKey(),
  active: boolean("active").notNull(),
  since: ts("since").notNull().defaultNow(),
  detail: text("detail"),
})

// ---------------------------------------------------------------------------
// Workflows (map), moves
// ---------------------------------------------------------------------------

export const workflows = pgTable(
  "workflows",
  {
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull(),
    name: text("name").notNull(),
    active: boolean("active").notNull(),
    archived: boolean("archived").notNull().default(false),
    triggerType: text("trigger_type").notNull(),
    triggerDetail: text("trigger_detail").notNull().default(""),
    /** Hash of node types and connections, names ignored, used to find duplicates. */
    structureHash: text("structure_hash").notNull(),
    nodeCount: integer("node_count").notNull(),
    credentialIds: jsonb("credential_ids").$type<string[]>().notNull().default([]),
    calledWorkflowIds: jsonb("called_workflow_ids").$type<string[]>().notNull().default([]),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    lastRunAt: ts("last_run_at"),
    runs30d: integer("runs_30d").notNull().default(0),
    errors30d: integer("errors_30d").notNull().default(0),
    syncedAt: ts("synced_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.instanceId, t.workflowId] }), index("workflows_hash_idx").on(t.structureHash)],
)

export const moves = pgTable("moves", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceInstanceId: uuid("source_instance_id").notNull(),
  targetInstanceId: uuid("target_instance_id").notNull(),
  workflowId: text("workflow_id").notNull(),
  workflowName: text("workflow_name").notNull(),
  newWorkflowId: text("new_workflow_id"),
  status: text("status").$type<"running" | "done" | "failed">().notNull(),
  steps: jsonb("steps").$type<{ step: string; ok: boolean; detail?: string }[]>().notNull().default([]),
  createdAt: created(),
})

// ---------------------------------------------------------------------------
// Worker jobs and backups
// ---------------------------------------------------------------------------

export type JobKind = "backup" | "export-credentials" | "probe" | "self-test"
export type JobStatus = "queued" | "running" | "done" | "failed"

export const workerJobs = pgTable(
  "worker_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    instanceId: uuid("instance_id").references(() => instances.id, { onDelete: "cascade" }),
    kind: text("kind").$type<JobKind>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: created(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("worker_jobs_queue_idx").on(t.workerId, t.status)],
)

export const backupRuns = pgTable(
  "backup_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for the n8n-ops self backup. */
    instanceId: uuid("instance_id").references(() => instances.id, { onDelete: "cascade" }),
    status: text("status").$type<"running" | "ok" | "failed">().notNull(),
    includesSecrets: boolean("includes_secrets").notNull().default(false),
    workflows: integer("workflows"),
    credentials: integer("credentials"),
    sizeBytes: integer("size_bytes"),
    sha256: text("sha256"),
    objectKey: text("object_key"),
    error: text("error"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("backup_runs_instance_idx").on(t.instanceId, t.startedAt)],
)

// ---------------------------------------------------------------------------
// Temporary access for agents to n8n instances, through the n8n-ops proxy
// ---------------------------------------------------------------------------

export type AccessStatus = "pending" | "approved" | "denied" | "expired" | "released" | "revoked"

export const accessRequests = pgTable(
  "access_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    /** Empty: the whole instance within the scopes. Otherwise only these workflows. */
    workflowIds: jsonb("workflow_ids").$type<string[]>().notNull().default([]),
    minutes: integer("minutes").notNull(),
    status: text("status").$type<AccessStatus>().notNull().default("pending"),
    requestedAt: created(),
    /** A pending request nobody answers expires at this time. */
    decideBy: ts("decide_by").notNull(),
    decidedAt: ts("decided_at"),
    decidedBy: text("decided_by"),
    decidedVia: text("decided_via"),
    expiresAt: ts("expires_at"),
    endedAt: ts("ended_at"),
    keyPrefix: text("key_prefix"),
    keyHash: text("key_hash").unique(),
    /** The key, encrypted, until the agent collects it once; then cleared. */
    keyEnc: text("key_enc"),
    keyCollectedAt: ts("key_collected_at"),
  },
  (t) => [index("access_requests_status_idx").on(t.status)],
)

export const accessCalls = pgTable(
  "access_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => accessRequests.id, { onDelete: "cascade" }),
    at: created(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    status: integer("status").notNull(),
    /** Why n8n-ops refused the call, when it did. */
    refused: text("refused"),
  },
  (t) => [index("access_calls_request_idx").on(t.requestId, t.at)],
)

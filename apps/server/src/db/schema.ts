import { type AccessChannel, type CapabilityKey, capabilityKeys } from "@n8n-ops/shared"
import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  doublePrecision,
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
import type { CauseKind, TargetSource } from "../services/cause.ts"
import type { RestoreKind, RestoreMode, RestorePlan, RestoreStatus, RestoreStep } from "../services/restore-types.ts"

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" })
const created = () => ts("created_at").notNull().defaultNow()
const updated = () => ts("updated_at").notNull().defaultNow()

/**
 * The cause of a Problem or an Affected workflow (docs/adr/0003, `services/cause.ts`): the target's stable key and its
 * label, which rule found it, the full reason and the kind. Null only on rows recorded before the regroup by cause.
 */
const causeColumns = () => ({
  targetKey: text("target_key"),
  target: text("target"),
  targetSource: text("target_source").$type<TargetSource>(),
  reason: text("reason"),
  kind: text("kind").$type<CauseKind>(),
})

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
  // The session clocks (services/session-policy.ts). Better Auth does not know these columns and never returns
  // them; the policy reads and writes them by session id. A session that replaces another one (a password
  // change, two-factor enrolment) takes over its sign-in and activity times.
  /** When the person signed in: the maximum length counts from here. */
  authenticatedAt: ts("authenticated_at").notNull().defaultNow(),
  /** The last request of any kind, polling included, kept to the minute: the lifetime counts from here. */
  seenAt: ts("seen_at").notNull().defaultNow(),
  /** The last real input (keys, pointer, wheel, touch) the page reported: the idle timeout counts from here. */
  activeAt: ts("active_at").notNull().defaultNow(),
  /** Why the session ended (lifetime, idle, max); it then answers every request with this until it is removed. */
  endedReason: text("ended_reason"),
  endedAt: ts("ended_at"),
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

/** Passkeys (the @better-auth/passkey plugin's model). Each one signs in on its own, in place of password and TOTP. */
export const passkey = pgTable(
  "auth_passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    createdAt: ts("created_at"),
    aaguid: text("aaguid"),
  },
  (t) => [uniqueIndex("auth_passkey_credential_idx").on(t.credentialID), index("auth_passkey_user_idx").on(t.userId)],
)

// ---------------------------------------------------------------------------
// Settings and audit
// ---------------------------------------------------------------------------

/** One row per settings section (alerts, telegram, email, backups, keys, defaults). Secrets inside are encrypted. */
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

/**
 * Who may call /mcp and /api/v1. A token made by hand (kind mcp or rest) carries its secret's hash. An agent
 * connected by approval (kind agent) has no secret of its own: it holds short access tokens and rotating refresh
 * tokens from the authorization server, all tied to its grant; this row is its identity and its rights.
 */
export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: text("kind").$type<"mcp" | "rest" | "agent">().notNull(),
  prefix: text("prefix").notNull(),
  /** For an agent, the hash of a random value nobody holds, so the column stays unique and unusable. */
  tokenHash: text("token_hash").notNull().unique(),
  /** May ask for temporary access to n8n instances (needs human approval each time). */
  canRequestAccess: boolean("can_request_access").notNull().default(false),
  createdAt: created(),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
  /** Agent: its grant in the authorization server. */
  grantId: text("grant_id").unique(),
  /** Agent: the public URL it connected to; a connection made under another one ends. */
  issuer: text("issuer"),
  /** Agent: the scopes the person granted (ops:read, ops:access). */
  scopes: jsonb("scopes").$type<string[]>(),
  /** Agent: how it connected: through a browser (MCP clients) or with a code (scripts). */
  connectedVia: text("connected_via").$type<"browser" | "code">(),
  /** Agent: where the browser was sent back after approval, as the person saw it. */
  redirectHost: text("redirect_host"),
  approvedBy: text("approved_by"),
  /** Agent: why it ended (revoked by a person, unused for 90 days, a reused refresh token, ...). */
  endReason: text("end_reason"),
})

/**
 * The authorization server's own records (oidc-provider): grants, codes, access and refresh tokens, clients
 * registered by agents, sessions and interactions. Opaque values, looked up by id; never shown in the UI.
 */
export const oauthStore = pgTable(
  "oauth_store",
  {
    type: text("type").notNull(),
    id: text("id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    grantId: text("grant_id"),
    userCode: text("user_code"),
    uid: text("uid"),
    expiresAt: ts("expires_at"),
    consumedAt: ts("consumed_at"),
  },
  (t) => [
    primaryKey({ columns: [t.type, t.id] }),
    index("oauth_store_grant_idx").on(t.grantId),
    index("oauth_store_user_code_idx").on(t.userCode),
    index("oauth_store_uid_idx").on(t.uid),
    index("oauth_store_expires_idx").on(t.expiresAt),
  ],
)

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

/** What the owner entered in Add worker: the socket proxy or the whole Docker socket, and the containers. */
export type WorkerInstall = { socketProxy: boolean; containers: string[] }

export const workers = pgTable("workers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").unique(),
  version: text("version"),
  lastSeenAt: ts("last_seen_at"),
  createdAt: created(),
  revokedAt: ts("revoked_at"),
  /** As entered in Add worker, copied from the pairing token; never changed. Null for workers added earlier. */
  install: jsonb("install").$type<WorkerInstall>(),
  /** The containers the socket proxy allows now, as the owner recorded them; null until recorded. */
  allowed: jsonb("allowed").$type<{ containers: string[] }>(),
  /** What the worker says it supports (x-worker-features), such as following a Compose service. */
  features: jsonb("features").$type<string[]>(),
})

export const pairingTokens = pgTable("worker_pairing_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: created(),
  install: jsonb("install").$type<WorkerInstall>(),
})

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

export type Health = "ok" | "warn" | "down" | "unknown"
export type CollectionMode = "direct" | "worker"
export type SetupCheckKind = "api" | "health" | "worker" | "backup"

/**
 * The last attempt of one setup check (services/setup.ts): its number and server start time, a fingerprint of the
 * settings it depends on (inputsOf), and once it ended whether it passed, why not, and what it found.
 */
export type SetupCheck = {
  attempt: number
  startedAt: string
  inputs: string
  status: "running" | "done"
  ok?: boolean
  at?: string
  reason?: string
  workerId?: string
  jobId?: string
  detail?: Record<string, unknown>
}

export const instances = pgTable("instances", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  baseUrl: text("base_url").notNull(),
  /** Null until the setup's API step stores a key, or after the owner removed it. */
  apiKeyEnc: text("api_key_enc"),
  /** "incomplete": a draft in setup that does nothing in the background; "complete": activated, never back. */
  setupState: text("setup_state").$type<"incomplete" | "complete">().notNull().default("complete"),
  /** What the owner wants this instance for (packages/shared instance-setup.ts); features off the list stay off. */
  chosenCapabilities: jsonb("chosen_capabilities")
    .$type<CapabilityKey[]>()
    .notNull()
    .default([...capabilityKeys]),
  /** When backup was last turned on (activation or Add capability); backups are missed from then. Null before. */
  backupSince: ts("backup_since"),
  /** How a backup is made: the worker in the main (with credential secrets), or the n8n API only. */
  backupVia: text("backup_via").$type<"worker" | "api">().notNull().default("api"),
  /**
   * Raised by every change of the base URL or the API key, so a key tested for one URL and key is stored only while
   * they are still those (PATCH and the setup's API step), and a meta read made for them is dropped after a change.
   */
  configRevision: integer("config_revision").notNull().default(0),
  /** Taken by every setup check when it starts, so a slow earlier attempt never overwrites a later one. */
  setupAttemptSeq: bigint("setup_attempt_seq", { mode: "number" }).notNull().default(0),
  /** The last attempt of each setup check. */
  setupChecks: jsonb("setup_checks").$type<Partial<Record<SetupCheckKind, SetupCheck>>>().notNull().default({}),
  /** Container name on the Docker host, used by the worker for docker exec. Null when a Compose service is set. */
  containerName: text("container_name"),
  /**
   * The main as a Compose project and service instead of a name: the worker uses the running container of that
   * service each time, so it follows docker rollout and redeploys. Both set or both null.
   */
  composeProject: text("compose_project"),
  composeService: text("compose_service"),
  workerId: uuid("worker_id").references(() => workers.id, { onDelete: "set null" }),
  queueMode: boolean("queue_mode").notNull().default(false),
  /** "manual": set by the owner; "found": read by the worker inside the main container, and not editable then. */
  queueModeSource: text("queue_mode_source").$type<"manual" | "found">().notNull().default("manual"),
  /**
   * Raised with every change of how health is collected (collection, worker, container, URLs, queue mode set by
   * hand). A check carries the revision it started from and is dropped if the instance has moved on.
   */
  collectionRevision: integer("collection_revision").notNull().default(0),
  /** Taken by every health check when it starts; the last one applied, so a slower earlier check never wins. */
  healthCheckSeq: bigint("health_check_seq", { mode: "number" }).notNull().default(0),
  healthAppliedSeq: bigint("health_applied_seq", { mode: "number" }).notNull().default(0),
  /** When the queue backlog went above the threshold; kept here so a restart does not reset it. */
  backlogSince: ts("backlog_since"),
  /** URL of the main process /metrics endpoint (queue instance). */
  metricsUrl: text("metrics_url"),
  /** Health URLs of queue workers. */
  workerHealthUrls: jsonb("worker_health_urls").$type<string[]>().notNull().default([]),
  /** How health and metrics are collected: directly from the server, or through the host worker. */
  collection: text("collection").$type<CollectionMode>().notNull().default("direct"),
  version: text("version"),
  /** The API key's scopes from /discover; null before the first read and on n8n older than 2.14.0. */
  scopes: jsonb("scopes").$type<string[] | null>(),
  scopesCheckedAt: ts("scopes_checked_at"),
  health: text("health").$type<Health>().notNull().default("unknown"),
  healthDetail: jsonb("health_detail").$type<Record<string, unknown>>(),
  healthCheckedAt: ts("health_checked_at"),
  /**
   * The health of the last check that read the instance, and when. A check that was not collected leaves them, so
   * the last known health stays while the health is unknown.
   */
  lastKnownHealth: text("last_known_health").$type<Exclude<Health, "unknown">>(),
  lastKnownAt: ts("last_known_at"),
  lastPollAt: ts("last_poll_at"),
  lastPollError: text("last_poll_error"),
  firstSyncDone: boolean("first_sync_done").notNull().default(false),
  /** Highest execution id already processed. */
  executionCursor: text("execution_cursor"),
  overrides: jsonb("overrides").$type<Record<string, unknown>>().notNull().default({}),
  /** "default": back up to the default destinations, as they change; "custom": to those it chose. */
  backupDestinations: text("backup_destinations").$type<"default" | "custom">().notNull().default("default"),
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

/**
 * One error, known by its exact text, wherever it happens (docs/adr/0001). Its state, failures and times are those
 * of its Affected workflows, read from them and never stored here.
 */
export const problems = pgTable(
  "problems",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The error the Problem is named by. After a Merge, its Affected workflows may carry other texts. */
    errorMessage: text("error_message").notNull(),
    /**
     * sha256 of the error text: a workflow that starts failing with it joins this Problem. Null on a Problem made by
     * Split, so that the text keeps joining the Problem it was split from.
     */
    fingerprint: text("fingerprint"),
    /** Set when a person merged this Problem into another. Its workflows moved there; it stays as an alias. */
    mergedInto: uuid("merged_into").references((): AnyPgColumn => problems.id, { onDelete: "cascade" }),
    ...causeColumns(),
    /**
     * Set by the regroup by cause (docs/adr/0003) on a Problem left without workflows. It keeps its id for old links,
     * which show where its workflows went (problem_regroups), and refuses every action.
     */
    regrouped: boolean("regrouped").notNull().default(false),
    /** Moves on whenever an Affected workflow joins or leaves (ingest, Merge, Split), so an Undo can tell. */
    version: integer("version").notNull().default(0),
    createdAt: created(),
  },
  (t) => [uniqueIndex("problems_fingerprint_idx").on(t.fingerprint)],
)

/** A workflow, at one node, that a Problem hit, with its own failures, times and state. */
export const affectedWorkflows = pgTable(
  "affected_workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    problemId: uuid("problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull(),
    workflowName: text("workflow_name").notNull(),
    nodeName: text("node_name").notNull(),
    /** n8n's error text of the latest failure. */
    errorMessage: text("error_message").notNull(),
    /** instance + workflow + node + cause key (docs/adr/0003): where a failed execution is counted. */
    fingerprint: text("fingerprint").notNull(),
    ...causeColumns(),
    status: text("status").$type<ProblemStatus>().notNull().default("open"),
    mutedUntil: ts("muted_until"),
    regression: boolean("regression").notNull().default(false),
    count: integer("count").notNull().default(0),
    firstSeen: ts("first_seen").notNull(),
    lastSeen: ts("last_seen").notNull(),
    resolvedAt: ts("resolved_at"),
    /**
     * Moves on with every change of the state an Undo restores (status, regression, mute end, resolved time), with
     * every new occurrence (count, first and last seen) and with a move to another Problem, whoever makes it: a
     * trigger (migrations 0007 and 0012) bumps it, so ingest, Merge, Split, housekeeping and Telegram count too (FB-16).
     */
    version: integer("version").notNull().default(0),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("affected_workflows_fingerprint_idx").on(t.fingerprint),
    index("affected_workflows_problem_idx").on(t.problemId),
    index("affected_workflows_status_idx").on(t.status),
    index("affected_workflows_instance_idx").on(t.instanceId),
  ],
)

/**
 * Ids of Affected workflows that the regroup by cause (docs/adr/0003) replaced, so old links and the Telegram messages
 * that name them still find their rows: `combined` when the row joined another with the same new key, `split` for
 * each new row that took some of its failures (the old id itself kept the cause of its latest failure).
 */
export const affectedWorkflowAliases = pgTable(
  "affected_workflow_aliases",
  {
    oldId: uuid("old_id").notNull(),
    newId: uuid("new_id")
      .notNull()
      .references(() => affectedWorkflows.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"combined" | "split">().notNull(),
  },
  (t) => [primaryKey({ columns: [t.oldId, t.newId] })],
)

/** Where the workflows of each Problem went in the regroup by cause, for the page of an old Problem. */
export const problemRegroups = pgTable(
  "problem_regroups",
  {
    oldProblemId: uuid("old_problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    newProblemId: uuid("new_problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    rows: integer("rows").notNull(),
  },
  (t) => [primaryKey({ columns: [t.oldProblemId, t.newProblemId] })],
)

/** The state of an Affected workflow that actions change and an Undo puts back. Times as ISO strings. */
export type ProblemState = {
  status: ProblemStatus
  regression: boolean
  mutedUntil: string | null
  resolvedAt: string | null
}

export type ProblemAction = "resolve" | "mute" | "reopen" | "unmute"

/** What an action changed: each Affected workflow, the version the action left it at, and its state before. */
export type ReceiptRow = { affectedWorkflowId: string; version: number; state: ProblemState }

/**
 * One receipt per problem action, for its Undo (FB-16). Single use and short lived. An Undo applies only while every
 * row the action changed is still at the version it left and still in the Problem, and, for an action on the whole
 * Problem, while no workflow joined or left it.
 */
export const problemReceipts = pgTable("problem_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  problemId: uuid("problem_id")
    .notNull()
    .references(() => problems.id, { onDelete: "cascade" }),
  /** The one Affected workflow the action was on; null for an action on the whole Problem. */
  affectedWorkflowId: uuid("affected_workflow_id").references(() => affectedWorkflows.id, { onDelete: "cascade" }),
  action: text("action").$type<ProblemAction>().notNull(),
  problemVersion: integer("problem_version").notNull(),
  prior: jsonb("prior").$type<ReceiptRow[]>().notNull(),
  createdAt: created(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
})

export const failures = pgTable(
  "failures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    affectedWorkflowId: uuid("affected_workflow_id")
      .notNull()
      .references(() => affectedWorkflows.id, { onDelete: "cascade" }),
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
    index("failures_affected_workflow_idx").on(t.affectedWorkflowId),
    index("failures_created_idx").on(t.createdAt),
  ],
)

// ---------------------------------------------------------------------------
// Health history
// ---------------------------------------------------------------------------

/** What made a check of the main fail, or that n8n-ops could not check it (services/health-history.ts). */
export type FailureKind = "timeout" | "refused" | "network" | "container" | "http" | "other" | "not-collected"

/**
 * One applied health check of an instance's main, kept for Keep health history (days). Facts of the check itself
 * (how it was made, the mode and the alert threshold then), so the history never reads them from today's settings.
 */
export const healthChecks = pgTable(
  "health_checks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    /** Server time when the check was applied; the order of the checks is the order of `id`. */
    checkedAt: ts("checked_at").notNull(),
    /** Who checked: the server over the network, or the instance's worker. */
    via: text("via").$type<"direct" | "worker">().notNull(),
    /** How the main was reached: inside its container, or over the network; null from workers that do not say. */
    source: text("source").$type<"inside" | "network">(),
    mode: text("mode").$type<"regular" | "queue">().notNull(),
    /** Down alert after failed checks in a row, as it was set for this check. */
    alertAfter: integer("alert_after").notNull(),
    /** Null when the check was not collected: it says nothing about the main. */
    mainOk: boolean("main_ok"),
    mainStatus: integer("main_status"),
    /** The /healthz request alone until its whole answer; null when not measured. */
    mainMs: integer("main_ms"),
    readinessOk: boolean("readiness_ok"),
    readinessMs: integer("readiness_ms"),
    failureKind: text("failure_kind").$type<FailureKind>(),
    code: text("code"),
    error: text("error"),
    /** This check queued a down alert (put it in the outbox; whether Telegram took it is not recorded here). */
    alertQueued: boolean("alert_queued").notNull().default(false),
  },
  (t) => [index("health_checks_instance_checked_idx").on(t.instanceId, t.checkedAt)],
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
    /** The error text of a problem alert. Problem alerts are grouped by the Problem their workflow is in when sent. */
    groupKey: text("group_key"),
    affectedWorkflowId: uuid("affected_workflow_id"),
    text: text("text").notNull(),
    status: text("status").$type<"pending" | "sent" | "merged" | "failed">().notNull().default("pending"),
    sendAfter: ts("send_after").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    telegramMessageId: integer("telegram_message_id"),
    /** Forum topic chosen by the routes when the alert was queued. Null is the chat's General topic. */
    threadId: integer("thread_id"),
    createdAt: created(),
    sentAt: ts("sent_at"),
  },
  (t) => [index("alert_outbox_pending_idx").on(t.status, t.sendAfter)],
)

/** A sent Telegram message about one Problem, which later alerts of the Problem edit instead of sending a new one. */
export const alertGroups = pgTable("alert_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The error text when the message was sent. */
  groupKey: text("group_key").notNull(),
  /** The Problem the message is about. Null on a message sent before 0012, which may list several. */
  problemId: uuid("problem_id"),
  telegramMessageId: integer("telegram_message_id").notNull(),
  /** The topic its alerts were routed to; problems group and edit only within it. Null is General. */
  threadId: integer("thread_id"),
  /** Telegram refused the topic and the message went to General; known only from that answer, never assumed. */
  fellBack: boolean("fell_back").notNull().default(false),
  /** Set when the message takes no later alerts: its send failed, it was deleted with its topic, or it predates 0012. */
  closedAt: ts("closed_at"),
  /** The Affected workflows the message lists. */
  affectedWorkflowIds: jsonb("affected_workflow_ids").$type<string[]>().notNull().default([]),
  /** Sent before the regroup by cause (docs/adr/0003): its buttons no longer act, they only say so. */
  beforeRegroup: boolean("before_regroup").notNull().default(false),
  createdAt: created(),
})

/** Ongoing health and backup conditions, so each alerts once when it starts. */
export const alertState = pgTable("alert_state", {
  key: text("key").primaryKey(),
  active: boolean("active").notNull(),
  since: ts("since").notNull().defaultNow(),
  detail: text("detail"),
  /** Failed checks in a row while the condition has not started yet (health conditions with a threshold). */
  failures: integer("failures").notNull().default(0),
  /** When the first of those failed checks was applied; null when there is no pending streak. */
  failingSince: ts("failing_since"),
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

// ---------------------------------------------------------------------------
// Worker health history (services/worker-health.ts): observations with their own times, periods derived on read
// ---------------------------------------------------------------------------

/** A job of the Worker that was running when an offline period began: a hint, never the cause. */
export type OfflineJob = { kind: JobKind; instance: string | null; startedAt: string }

/**
 * An ended time the Worker was offline: from when its status turned Offline (last call + 90 s) to the call that ended
 * it. An ongoing one is derived from `workers.last_seen_at` when reading.
 */
export const workerOffline = pgTable(
  "worker_offline",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    from: ts("from").notNull(),
    to: ts("to").notNull(),
    job: jsonb("job").$type<OfflineJob>(),
  },
  (t) => [index("worker_offline_worker_to_idx").on(t.workerId, t.to)],
)

/**
 * Stretches of time in which this server recorded continuously; time covered by none of them is when n8n-ops was not
 * recording. Written only by `markAlive`.
 */
export const serverRecording = pgTable("server_recording", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  startedAt: ts("started_at").notNull(),
  aliveAt: ts("alive_at").notNull(),
})

/** Instants the history may start at, by data kind: the first recording, and the cutoff the last prune applied. */
export const historyMarks = pgTable("history_marks", {
  key: text("key").primaryKey(),
  before: ts("before").notNull(),
})

/**
 * One heartbeat of a Worker, as it reported it. The unique key makes a resend or a replay store nothing; times are
 * the server's receipt minus the ages the Worker measured on its monotonic clock.
 */
export const workerBeats = pgTable(
  "worker_beats",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    bootId: text("boot_id").notNull(),
    seq: integer("seq").notNull(),
    receivedAt: ts("received_at").notNull(),
    uptimeSec: doublePrecision("uptime_sec").notNull(),
    rttMs: integer("rtt_ms"),
    rttAt: ts("rtt_at"),
    failedCalls: integer("failed_calls"),
    lastCallError: text("last_call_error"),
    dockerCheckedAt: ts("docker_checked_at"),
    dockerOk: boolean("docker_ok"),
    dockerMs: integer("docker_ms"),
    dockerError: text("docker_error"),
    dockerChecks: integer("docker_checks"),
    dockerFailed: integer("docker_failed"),
  },
  (t) => [
    uniqueIndex("worker_beats_boot_seq_idx").on(t.workerId, t.bootId, t.seq),
    index("worker_beats_worker_received_idx").on(t.workerId, t.receivedAt),
  ],
)

/** ok: every copy was written and verified; partial: some were; failed: none was. */
export type RunStatus = "running" | "ok" | "partial" | "failed"

export const backupRuns = pgTable(
  "backup_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for the n8n-ops self backup. */
    instanceId: uuid("instance_id").references(() => instances.id, { onDelete: "cascade" }),
    status: text("status").$type<RunStatus>().notNull(),
    includesSecrets: boolean("includes_secrets").notNull().default(false),
    workflows: integer("workflows"),
    credentials: integer("credentials"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sha256: text("sha256"),
    error: text("error"),
    /** What the socket proxy refused when that made the backup fail: the call and the container. */
    refusal: jsonb("refusal").$type<{
      call: string
      container?: string
      resolvedContainer?: string
      replicasClean?: boolean
    }>(),
    /** Set when the worker starts its one upload of the archive; a second upload is refused. */
    uploadStartedAt: ts("upload_started_at"),
    /** The encrypted archive is in the spool with the declared size and checksum; copies can be written. */
    spooledAt: ts("spooled_at"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("backup_runs_instance_idx").on(t.instanceId, t.startedAt)],
)

/**
 * One restore of one item from an archive (requirement D6): reviewed first (`previewed`), then confirmed once.
 * The row is written before anything is created in n8n, so a restore cut off midway is never lost or run twice.
 * It never holds the private key or credential secrets.
 */
export const restores = pgTable(
  "restores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** In the name of everything this restore creates, so each item can be found again for this restore alone. */
    code: text("code").notNull().unique(),
    /** Who reviewed it, then who confirmed it: the name in the audit and the person's or token's ID. */
    actor: text("actor").notNull(),
    actorId: text("actor_id"),
    via: text("via").notNull(),
    runId: uuid("run_id").references(() => backupRuns.id, { onDelete: "set null" }),
    /** Null once the instance is removed: the record of what was written there stays (its name is in `reviewed`). */
    targetInstanceId: uuid("target_instance_id").references(() => instances.id, { onDelete: "set null" }),
    kind: text("kind").$type<RestoreKind>().notNull(),
    itemId: text("item_id").notNull(),
    itemName: text("item_name").notNull(),
    mode: text("mode").$type<RestoreMode>().notNull(),
    status: text("status").$type<RestoreStatus>().notNull(),
    /** What the owner reviewed: every action, the names it creates, and what is not restored. */
    reviewed: jsonb("reviewed").$type<RestorePlan>().notNull(),
    /** Each creation step with what became of it. */
    steps: jsonb("steps").$type<RestoreStep[]>().notNull().default([]),
    error: text("error"),
    /**
     * The Version before replace: the workflow as n8n held it right before a replace wrote over it, as a one-workflow
     * archive (base64), age-encrypted to the backup public key and to the key pasted for the restore. Stored before
     * the write and kept as long as this row. Never holds credential secrets.
     */
    beforeArchive: text("before_archive"),
    beforeSha256: text("before_sha256"),
    beforeTakenAt: ts("before_taken_at"),
    /** A restore from another restore's Version before replace, instead of from a backup run (`run_id`). */
    fromRestoreId: uuid("from_restore_id").references((): AnyPgColumn => restores.id, { onDelete: "set null" }),
    createdAt: created(),
    confirmedAt: ts("confirmed_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("restores_target_idx").on(t.targetInstanceId, t.createdAt),
    index("restores_status_idx").on(t.status, t.createdAt),
  ],
)

export type DestinationKind = "s3" | "local" | "sftp" | "webdav"
export type RetentionPolicy = { daily: number; weekly: number; monthly: number }
export type ObjectLock = { mode: "COMPLIANCE" | "GOVERNANCE"; days: number }

/** Where archives are written. An instance writes to the default ones or to those it chose. */
export const backupDestinations = pgTable("backup_destinations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  kind: text("kind").$type<DestinationKind>().notNull(),
  /**
   * Where the archives are (bucket and prefix, folder, host and path, URL, and the account where it decides
   * the place). Fixed once set, so earlier copies are always found where they were written.
   */
  location: jsonb("location").$type<Record<string, unknown>>().notNull(),
  /** Credentials; secret fields are stored encrypted as <name>Enc. */
  credentials: jsonb("credentials").$type<Record<string, unknown>>().notNull().default({}),
  retention: jsonb("retention").$type<RetentionPolicy>().notNull(),
  /** S3 Object Lock for every new copy; null when off. */
  objectLock: jsonb("object_lock").$type<ObjectLock | null>(),
  enabled: boolean("enabled").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
  /** When the location became fixed: on creation, or for settings carried over incomplete, at their first test. */
  lockedAt: ts("locked_at"),
  createdAt: created(),
  updatedAt: updated(),
})

export type CopyStatus = "pending" | "writing" | "ok" | "failed"
export type Leftover = { versionId: string | null; retainUntil: string | null }

/** One archive of one run on one destination. */
export const backupCopies = pgTable(
  "backup_copies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => backupRuns.id, { onDelete: "cascade" }),
    destinationId: uuid("destination_id")
      .notNull()
      .references(() => backupDestinations.id, { onDelete: "restrict" }),
    /** Path of the archive under the destination's root. */
    objectKey: text("object_key").notNull(),
    status: text("status").$type<CopyStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at"),
    error: text("error"),
    /** S3 version of the copy, so expiry removes that version and not only hides it. */
    versionId: text("version_id"),
    /** Object Lock: the copy cannot be deleted before this time. */
    retainUntil: ts("retain_until"),
    /** Read back (or checked by the service) with the run's size and SHA-256. */
    verifiedAt: ts("verified_at"),
    /** Written before destinations existed; verified with the checks of that time. */
    legacy: boolean("legacy").notNull().default(false),
    /**
     * Objects written under this copy's key that it does not hold: an S3 version from a failed attempt, or the
     * file of a copy that failed. Removed once no lock holds them (retainUntil passed or none).
     */
    leftovers: jsonb("leftovers").$type<Leftover[]>().notNull().default([]),
    createdAt: created(),
    finishedAt: ts("finished_at"),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    uniqueIndex("backup_copies_run_destination_idx").on(t.runId, t.destinationId),
    index("backup_copies_destination_idx").on(t.destinationId, t.status),
  ],
)

/** Destinations an instance chose; used only when its backup destinations are "custom". */
export const instanceBackupDestinations = pgTable(
  "instance_backup_destinations",
  {
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    destinationId: uuid("destination_id")
      .notNull()
      .references(() => backupDestinations.id, { onDelete: "cascade" }),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.instanceId, t.destinationId] })],
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
    reason: text("reason").notNull(),
    /** The minutes the agent asked for. */
    requestedMinutes: integer("requested_minutes").notNull(),
    /** While pending, the minutes an approver means to grant (the draft); once approved, the minutes granted. */
    minutes: integer("minutes").notNull(),
    /**
     * Bumped by every edit of the draft; a decision names the revision the approver saw, so a view from before an
     * edit can never approve something it did not show.
     */
    revision: integer("revision").notNull().default(0),
    status: text("status").$type<AccessStatus>().notNull().default("pending"),
    requestedAt: created(),
    /** A pending request nobody answers expires at this time. */
    decideBy: ts("decide_by").notNull(),
    decidedAt: ts("decided_at"),
    decidedBy: text("decided_by"),
    decidedVia: text("decided_via"),
    expiresAt: ts("expires_at"),
    endedAt: ts("ended_at"),
    /** What the agent says it did, given when it released the access; null when it gave none. */
    summary: text("summary"),
    /**
     * Calls made with the key, counted with each logged call in the same transaction; the Telegram message is marked
     * as up to date only while it is the count shown.
     */
    callCount: integer("call_count").notNull().default(0),
    keyPrefix: text("key_prefix"),
    keyHash: text("key_hash").unique(),
    /** The key, encrypted, until the agent collects it once; then cleared. */
    keyEnc: text("key_enc"),
    keyCollectedAt: ts("key_collected_at"),
    /** Telegram message with the Approve and Deny buttons; edited when it is decided and when access ends. */
    telegramMessageId: integer("telegram_message_id"),
    /** The access requests topic, when it was gone and the message went to General; its note stays in every edit. */
    telegramMissingTopic: integer("telegram_missing_topic"),
    /** When the message last showed the current status; cleared on every change of status. */
    telegramClosedAt: ts("telegram_closed_at"),
    emailSentAt: ts("email_sent_at"),
    /**
     * The channels the agent asked to tell approvers on; null when it chose none, and for requests made before it
     * could, which follow Settings → Agent Access like any other.
     */
    notifyChoice: jsonb("notify_choice").$type<AccessChannel[]>(),
    /**
     * When the last attempt on each channel failed, as an ISO time, until that channel succeeds; each channel waits
     * its own retry time, so a failure on one never holds back another.
     */
    notifyFailed: jsonb("notify_failed").$type<Partial<Record<AccessChannel, string>>>().notNull().default({}),
    /** Last attempt to notify approvers, and its error, for retries. */
    notifyAttemptAt: ts("notify_attempt_at"),
    notifyError: text("notify_error"),
  },
  (t) => [index("access_requests_status_idx").on(t.status)],
)

/** Why an instance of a request was left out when it was approved. */
export type AccessDropReason = "closed" | "deleted" | "no_scopes"

/**
 * The instances of an access request, each with its scopes and workflows: what the agent asked for, and the draft an
 * approver edits, which becomes what was granted. An instance an approver added has no requested values. A deleted
 * instance keeps its row and name, so the request's history stays whole.
 */
export const accessRequestInstances = pgTable(
  "access_request_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => accessRequests.id, { onDelete: "cascade" }),
    instanceId: uuid("instance_id").references(() => instances.id, { onDelete: "set null" }),
    /** The instance's name when it was added to the request. */
    instanceName: text("instance_name").notNull(),
    /** Its place in the request, fixed once given; Telegram buttons name an instance by it. */
    position: integer("position").notNull(),
    /** Null when an approver added the instance. */
    requestedScopes: jsonb("requested_scopes").$type<string[]>(),
    requestedWorkflowIds: jsonb("requested_workflow_ids").$type<string[]>(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    /** Empty: the whole instance within the scopes. Otherwise only these workflows. */
    workflowIds: jsonb("workflow_ids").$type<string[]>().notNull().default([]),
    /** The names of those workflows when they were added, by ID; a name that could not be read is missing. */
    workflowNames: jsonb("workflow_names").$type<Record<string, string>>().notNull().default({}),
    /** Whether the draft, or the approval, includes this instance. */
    included: boolean("included").notNull().default(true),
    /** Set when the approval left the instance out although it was included. */
    droppedReason: text("dropped_reason").$type<AccessDropReason>(),
    /** Scopes the approval left out because the instance no longer allowed them. */
    droppedScopes: jsonb("dropped_scopes").$type<string[]>().notNull().default([]),
  },
  (t) => [
    uniqueIndex("access_request_instances_position_idx").on(t.requestId, t.position),
    uniqueIndex("access_request_instances_instance_idx")
      .on(t.requestId, t.instanceId)
      .where(sql`${t.instanceId} is not null`),
    index("access_request_instances_instance_ref_idx").on(t.instanceId),
  ],
)

export const accessCalls = pgTable(
  "access_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => accessRequests.id, { onDelete: "cascade" }),
    /** The instance the call went to; null for a deleted instance. */
    instanceId: uuid("instance_id").references(() => instances.id, { onDelete: "set null" }),
    at: created(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    status: integer("status").notNull(),
    /** Why n8n-ops refused the call, when it did. */
    refused: text("refused"),
  },
  (t) => [index("access_calls_request_idx").on(t.requestId, t.at)],
)

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

const causeColumns = () => ({
  targetKey: text("target_key"),
  target: text("target"),
  targetSource: text("target_source").$type<TargetSource>(),
  reason: text("reason"),
  kind: text("kind").$type<CauseKind>(),
})

export const user = pgTable(
  "auth_user",
  {
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
  },
  () => [uniqueIndex("auth_user_single").on(sql`(true)`)],
)

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
  authenticatedAt: ts("authenticated_at").notNull().defaultNow(),
  seenAt: ts("seen_at").notNull().defaultNow(),
  activeAt: ts("active_at").notNull().defaultNow(),
  endedReason: text("ended_reason"),
  endedAt: ts("ended_at"),
  twoFactorVerified: boolean("two_factor_verified").notNull().default(false),
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
  kind: text("kind").$type<"mcp" | "rest" | "agent">().notNull(),
  prefix: text("prefix").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  canRequestAccess: boolean("can_request_access").notNull().default(false),
  createdAt: created(),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
  grantId: text("grant_id").unique(),
  issuer: text("issuer"),
  scopes: jsonb("scopes").$type<string[]>(),
  connectedVia: text("connected_via").$type<"browser" | "code">(),
  redirectHost: text("redirect_host"),
  approvedBy: text("approved_by"),
  endReason: text("end_reason"),
})

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

export const agentState = pgTable("agent_state", {
  id: integer("id").primaryKey(),
  generation: integer("generation").notNull().default(0),
  issuer: text("issuer"),
})

export const agentResets = pgTable("agent_resets", {
  id: text("id").primaryKey(),
  createdAt: created(),
})

export const agentConsent = pgTable(
  "agent_consent",
  {
    key: text("key").primaryKey(),
    generation: integer("generation").notNull(),
    sessionId: text("session_id"),
    decidedAt: ts("decided_at"),
    createdAt: created(),
  },
  (t) => [index("agent_consent_created_idx").on(t.createdAt)],
)

export type WorkerInstall = { socketProxy: boolean; containers: string[] }

export const workers = pgTable("workers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").unique(),
  version: text("version"),
  lastSeenAt: ts("last_seen_at"),
  createdAt: created(),
  revokedAt: ts("revoked_at"),
  install: jsonb("install").$type<WorkerInstall>(),
  allowed: jsonb("allowed").$type<{ containers: string[] }>(),
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

export type Health = "ok" | "warn" | "down" | "unknown"
export type CollectionMode = "direct" | "worker"
export type SetupCheckKind = "api" | "health" | "worker" | "backup"

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
  apiKeyEnc: text("api_key_enc"),
  setupState: text("setup_state").$type<"incomplete" | "complete">().notNull().default("complete"),
  chosenCapabilities: jsonb("chosen_capabilities")
    .$type<CapabilityKey[]>()
    .notNull()
    .default([...capabilityKeys]),
  backupSince: ts("backup_since"),
  backupVia: text("backup_via").$type<"worker" | "api">().notNull().default("api"),
  configRevision: integer("config_revision").notNull().default(0),
  setupAttemptSeq: bigint("setup_attempt_seq", { mode: "number" }).notNull().default(0),
  setupChecks: jsonb("setup_checks").$type<Partial<Record<SetupCheckKind, SetupCheck>>>().notNull().default({}),
  containerName: text("container_name"),
  composeProject: text("compose_project"),
  composeService: text("compose_service"),
  workerId: uuid("worker_id").references(() => workers.id, { onDelete: "set null" }),
  queueMode: boolean("queue_mode").notNull().default(false),
  queueModeSource: text("queue_mode_source").$type<"manual" | "found">().notNull().default("manual"),
  collectionRevision: integer("collection_revision").notNull().default(0),
  healthCheckSeq: bigint("health_check_seq", { mode: "number" }).notNull().default(0),
  healthAppliedSeq: bigint("health_applied_seq", { mode: "number" }).notNull().default(0),
  backlogSince: ts("backlog_since"),
  metricsUrl: text("metrics_url"),
  workerHealthUrls: jsonb("worker_health_urls").$type<string[]>().notNull().default([]),
  collection: text("collection").$type<CollectionMode>().notNull().default("direct"),
  version: text("version"),
  scopes: jsonb("scopes").$type<string[] | null>(),
  scopesCheckedAt: ts("scopes_checked_at"),
  health: text("health").$type<Health>().notNull().default("unknown"),
  healthDetail: jsonb("health_detail").$type<Record<string, unknown>>(),
  healthCheckedAt: ts("health_checked_at"),
  lastKnownHealth: text("last_known_health").$type<Exclude<Health, "unknown">>(),
  lastKnownAt: ts("last_known_at"),
  lastPollAt: ts("last_poll_at"),
  lastPollError: text("last_poll_error"),
  firstSyncDone: boolean("first_sync_done").notNull().default(false),
  executionCursor: text("execution_cursor"),
  overrides: jsonb("overrides").$type<Record<string, unknown>>().notNull().default({}),
  backupDestinations: text("backup_destinations").$type<"default" | "custom">().notNull().default("default"),
  agentAccess: jsonb("agent_access").$type<AgentAccessPolicy>().notNull().default({ enabled: false, scopes: [] }),
  createdAt: created(),
  updatedAt: updated(),
})

export type AgentAccessPolicy = { enabled: boolean; scopes: string[] }

export type ProblemStatus = "open" | "resolved" | "muted"

export const problems = pgTable(
  "problems",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    errorMessage: text("error_message").notNull(),
    fingerprint: text("fingerprint"),
    mergedInto: uuid("merged_into").references((): AnyPgColumn => problems.id, { onDelete: "cascade" }),
    ...causeColumns(),
    regrouped: boolean("regrouped").notNull().default(false),
    version: integer("version").notNull().default(0),
    createdAt: created(),
  },
  (t) => [uniqueIndex("problems_fingerprint_idx").on(t.fingerprint)],
)

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
    errorMessage: text("error_message").notNull(),
    fingerprint: text("fingerprint").notNull(),
    ...causeColumns(),
    status: text("status").$type<ProblemStatus>().notNull().default("open"),
    mutedUntil: ts("muted_until"),
    regression: boolean("regression").notNull().default(false),
    count: integer("count").notNull().default(0),
    firstSeen: ts("first_seen").notNull(),
    lastSeen: ts("last_seen").notNull(),
    resolvedAt: ts("resolved_at"),
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

export type ProblemState = {
  status: ProblemStatus
  regression: boolean
  mutedUntil: string | null
  resolvedAt: string | null
}

export type ProblemAction = "resolve" | "mute" | "reopen" | "unmute"

export type ReceiptRow = { affectedWorkflowId: string; version: number; state: ProblemState }

export const problemReceipts = pgTable("problem_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  problemId: uuid("problem_id")
    .notNull()
    .references(() => problems.id, { onDelete: "cascade" }),
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
    data: jsonb("data"),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("failures_execution_idx").on(t.instanceId, t.executionId),
    index("failures_affected_workflow_idx").on(t.affectedWorkflowId),
    index("failures_created_idx").on(t.createdAt),
  ],
)

export type FailureKind = "timeout" | "refused" | "network" | "container" | "http" | "other" | "not-collected"

export const healthChecks = pgTable(
  "health_checks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    checkedAt: ts("checked_at").notNull(),
    via: text("via").$type<"direct" | "worker">().notNull(),
    source: text("source").$type<"inside" | "network">(),
    mode: text("mode").$type<"regular" | "queue">().notNull(),
    alertAfter: integer("alert_after").notNull(),
    mainOk: boolean("main_ok"),
    mainStatus: integer("main_status"),
    mainMs: integer("main_ms"),
    readinessOk: boolean("readiness_ok"),
    readinessMs: integer("readiness_ms"),
    failureKind: text("failure_kind").$type<FailureKind>(),
    code: text("code"),
    error: text("error"),
    alertQueued: boolean("alert_queued").notNull().default(false),
  },
  (t) => [index("health_checks_instance_checked_idx").on(t.instanceId, t.checkedAt)],
)

export type AlertKind = "problem" | "health" | "backup" | "test"

export const alertOutbox = pgTable(
  "alert_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<AlertKind>().notNull(),
    groupKey: text("group_key"),
    affectedWorkflowId: uuid("affected_workflow_id"),
    text: text("text").notNull(),
    status: text("status").$type<"pending" | "sent" | "merged" | "failed">().notNull().default("pending"),
    sendAfter: ts("send_after").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    telegramMessageId: integer("telegram_message_id"),
    threadId: integer("thread_id"),
    createdAt: created(),
    sentAt: ts("sent_at"),
  },
  (t) => [index("alert_outbox_pending_idx").on(t.status, t.sendAfter)],
)

export const alertGroups = pgTable("alert_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupKey: text("group_key").notNull(),
  problemId: uuid("problem_id"),
  telegramMessageId: integer("telegram_message_id").notNull(),
  threadId: integer("thread_id"),
  fellBack: boolean("fell_back").notNull().default(false),
  closedAt: ts("closed_at"),
  affectedWorkflowIds: jsonb("affected_workflow_ids").$type<string[]>().notNull().default([]),
  beforeRegroup: boolean("before_regroup").notNull().default(false),
  createdAt: created(),
})

export const alertState = pgTable("alert_state", {
  key: text("key").primaryKey(),
  active: boolean("active").notNull(),
  since: ts("since").notNull().defaultNow(),
  detail: text("detail"),
  failures: integer("failures").notNull().default(0),
  failingSince: ts("failing_since"),
})

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
  (t) => [
    index("worker_jobs_queue_idx").on(t.workerId, t.status),
    index("worker_jobs_finished_idx")
      .on(t.finishedAt)
      .where(sql`${t.status} in ('done', 'failed') and ${t.kind} <> 'backup'`),
  ],
)

export type OfflineJob = { kind: JobKind; instance: string | null; startedAt: string }

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

export const serverRecording = pgTable("server_recording", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  startedAt: ts("started_at").notNull(),
  aliveAt: ts("alive_at").notNull(),
})

export const historyMarks = pgTable("history_marks", {
  key: text("key").primaryKey(),
  before: ts("before").notNull(),
})

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

export type RunStatus = "running" | "ok" | "partial" | "failed"

export const backupRuns = pgTable(
  "backup_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("instance_id").references(() => instances.id, { onDelete: "cascade" }),
    status: text("status").$type<RunStatus>().notNull(),
    includesSecrets: boolean("includes_secrets").notNull().default(false),
    workflows: integer("workflows"),
    credentials: integer("credentials"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sha256: text("sha256"),
    error: text("error"),
    refusal: jsonb("refusal").$type<{
      call: string
      container?: string
      resolvedContainer?: string
      replicasClean?: boolean
    }>(),
    uploadStartedAt: ts("upload_started_at"),
    spooledAt: ts("spooled_at"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("backup_runs_instance_idx").on(t.instanceId, t.startedAt)],
)

export const restores = pgTable(
  "restores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    actor: text("actor").notNull(),
    actorId: text("actor_id"),
    via: text("via").notNull(),
    runId: uuid("run_id").references(() => backupRuns.id, { onDelete: "set null" }),
    targetInstanceId: uuid("target_instance_id").references(() => instances.id, { onDelete: "set null" }),
    kind: text("kind").$type<RestoreKind>().notNull(),
    itemId: text("item_id").notNull(),
    itemName: text("item_name").notNull(),
    mode: text("mode").$type<RestoreMode>().notNull(),
    status: text("status").$type<RestoreStatus>().notNull(),
    reviewed: jsonb("reviewed").$type<RestorePlan>().notNull(),
    steps: jsonb("steps").$type<RestoreStep[]>().notNull().default([]),
    error: text("error"),
    beforeArchive: text("before_archive"),
    beforeSha256: text("before_sha256"),
    beforeTakenAt: ts("before_taken_at"),
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

export const backupDestinations = pgTable("backup_destinations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  kind: text("kind").$type<DestinationKind>().notNull(),
  location: jsonb("location").$type<Record<string, unknown>>().notNull(),
  credentials: jsonb("credentials").$type<Record<string, unknown>>().notNull().default({}),
  retention: jsonb("retention").$type<RetentionPolicy>().notNull(),
  objectLock: jsonb("object_lock").$type<ObjectLock | null>(),
  enabled: boolean("enabled").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
  lockedAt: ts("locked_at"),
  createdAt: created(),
  updatedAt: updated(),
})

export type CopyStatus = "pending" | "writing" | "ok" | "failed"
export type Leftover = { versionId: string | null; retainUntil: string | null }

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
    objectKey: text("object_key").notNull(),
    status: text("status").$type<CopyStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at"),
    error: text("error"),
    versionId: text("version_id"),
    retainUntil: ts("retain_until"),
    verifiedAt: ts("verified_at"),
    legacy: boolean("legacy").notNull().default(false),
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

export type AccessStatus = "pending" | "approved" | "denied" | "expired" | "released" | "revoked"

export const accessRequests = pgTable(
  "access_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    requestedMinutes: integer("requested_minutes").notNull(),
    minutes: integer("minutes").notNull(),
    revision: integer("revision").notNull().default(0),
    status: text("status").$type<AccessStatus>().notNull().default("pending"),
    requestedAt: created(),
    decideBy: ts("decide_by").notNull(),
    decidedAt: ts("decided_at"),
    decidedBy: text("decided_by"),
    decidedVia: text("decided_via"),
    expiresAt: ts("expires_at"),
    endedAt: ts("ended_at"),
    summary: text("summary"),
    callCount: integer("call_count").notNull().default(0),
    refusedCount: integer("refused_count").notNull().default(0),
    keyPrefix: text("key_prefix"),
    keyHash: text("key_hash").unique(),
    keyEnc: text("key_enc"),
    keyCollectedAt: ts("key_collected_at"),
    telegramMessageId: integer("telegram_message_id"),
    telegramMissingTopic: integer("telegram_missing_topic"),
    telegramClosedAt: ts("telegram_closed_at"),
    emailSentAt: ts("email_sent_at"),
    notifyChoice: jsonb("notify_choice").$type<AccessChannel[]>(),
    notifyFailed: jsonb("notify_failed").$type<Partial<Record<AccessChannel, string>>>().notNull().default({}),
    notifyAttemptAt: ts("notify_attempt_at"),
    notifyError: text("notify_error"),
  },
  (t) => [index("access_requests_status_idx").on(t.status)],
)

export type AccessDropReason = "closed" | "deleted" | "no_scopes"

export const accessRequestInstances = pgTable(
  "access_request_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => accessRequests.id, { onDelete: "cascade" }),
    instanceId: uuid("instance_id").references(() => instances.id, { onDelete: "set null" }),
    instanceName: text("instance_name").notNull(),
    position: integer("position").notNull(),
    requestedScopes: jsonb("requested_scopes").$type<string[]>(),
    requestedWorkflowIds: jsonb("requested_workflow_ids").$type<string[]>(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    workflowIds: jsonb("workflow_ids").$type<string[]>().notNull().default([]),
    workflowNames: jsonb("workflow_names").$type<Record<string, string>>().notNull().default({}),
    included: boolean("included").notNull().default(true),
    droppedReason: text("dropped_reason").$type<AccessDropReason>(),
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
    instanceId: uuid("instance_id").references(() => instances.id, { onDelete: "set null" }),
    at: created(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    status: integer("status"),
    refused: text("refused"),
    change: boolean("change")
      .notNull()
      .generatedAlwaysAs(sql`method NOT IN ('GET', 'HEAD', 'OPTIONS') AND refused IS NULL`),
  },
  (t) => [
    index("access_calls_request_idx").on(t.requestId, t.at),
    index("access_calls_request_change_idx").on(t.requestId, t.change, t.at),
  ],
)

export type CompactionStatus = "running" | "done" | "failed" | "unknown"

export const dbCompactions = pgTable("db_compactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tableName: text("table_name").notNull(),
  relationId: bigint("relation_id", { mode: "number" }).notNull(),
  status: text("status").$type<CompactionStatus>().notNull().default("running"),
  sizeBefore: bigint("size_before", { mode: "number" }),
  sizeAfter: bigint("size_after", { mode: "number" }),
  error: text("error"),
  startedBy: text("started_by").notNull(),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
})

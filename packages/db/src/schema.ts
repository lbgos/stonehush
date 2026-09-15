import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const engagements = sqliteTable(
  "engagements",
  {
    id: text("id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    revision: integer("revision").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["ctf", "lab", "assessment"] }).notNull(),
    status: text("status", { enum: ["active", "archived"] }).notNull(),
    description: text("description"),
    authorizationContext: text("authorization_context"),
    autoContinueWarnings: integer("auto_continue_warnings", {
      mode: "boolean",
    }).notNull(),
    deadlineAt: text("deadline_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("engagement_contract_version", sql`${table.contractVersion} = 1`),
    check("engagement_revision_positive", sql`${table.revision} >= 1`),
    check(
      "engagement_name_length",
      sql`length(${table.name}) between 1 and 120 and ${table.name} = trim(${table.name})`,
    ),
    check(
      "engagement_kind",
      sql`${table.kind} in ('ctf', 'lab', 'assessment')`,
    ),
    check(
      "engagement_status",
      sql`${table.status} in ('active', 'archived')`,
    ),
    check(
      "engagement_description_length",
      sql`${table.description} is null or length(${table.description}) <= 4096`,
    ),
    check(
      "engagement_authorization_context_length",
      sql`${table.authorizationContext} is null or length(${table.authorizationContext}) <= 4096`,
    ),
    check(
      "engagement_auto_continue_boolean",
      sql`${table.autoContinueWarnings} in (0, 1)`,
    ),
    index("engagement_status_created_idx").on(table.status, table.createdAt),
  ],
);

export const scopeRevisions = sqliteTable(
  "scope_revisions",
  {
    id: text("id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    engagementId: text("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    rulesJson: text("rules_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("scope_revision_contract_version", sql`${table.contractVersion} = 1`),
    check("scope_revision_version_positive", sql`${table.version} >= 1`),
    check("scope_revision_rules_json", sql`json_valid(${table.rulesJson})`),
    uniqueIndex("scope_revision_engagement_version_unique").on(
      table.engagementId,
      table.version,
    ),
    uniqueIndex("scope_revision_engagement_id_unique").on(
      table.engagementId,
      table.id,
    ),
  ],
);

export const engagementActiveScopes = sqliteTable(
  "engagement_active_scopes",
  {
    engagementId: text("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "restrict" }),
    scopeRevisionId: text("scope_revision_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.engagementId] }),
    foreignKey({
      columns: [table.engagementId, table.scopeRevisionId],
      foreignColumns: [scopeRevisions.engagementId, scopeRevisions.id],
      name: "active_scope_belongs_to_engagement",
    }).onDelete("restrict"),
  ],
);

export const engagementNotes = sqliteTable(
  "engagement_notes",
  {
    engagementId: text("engagement_id")
      .primaryKey()
      .references(() => engagements.id, { onDelete: "restrict" }),
    markdown: text("markdown").notNull(),
    updatedAt: text("updated_at").notNull(),
    revision: integer("revision").notNull(),
  },
  (table) => [
    check(
      "engagement_notes_markdown_bytes",
      sql`length(cast(${table.markdown} as blob)) <= 65536`,
    ),
    check("engagement_notes_updated_at", sql`length(${table.updatedAt}) >= 20`),
    check("engagement_notes_revision", sql`${table.revision} >= 1`),
  ],
);

export const operatorCommandIdempotency = sqliteTable(
  "operator_command_idempotency",
  {
    actorId: text("actor_id").notNull(),
    route: text("route").notNull(),
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    canonicalizationProfile: text("canonicalization_profile").notNull(),
    requestDigest: text("request_digest").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBodyJson: text("response_body_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.actorId,
        table.route,
        table.operation,
        table.idempotencyKey,
      ],
    }),
    check(
      "operator_command_actor",
      sql`length(${table.actorId}) between 1 and 128 and ${table.actorId} not glob '*[^ -~]*'`,
    ),
    check(
      "operator_command_route",
      sql`length(${table.route}) between 1 and 2048 and ${table.route} glob '/api/v1/*' and ${table.route} not glob '*[^!-~]*' and ${table.route} not glob '*[?#]*'`,
    ),
    check(
      "operator_command_operation",
      sql`length(${table.operation}) between 1 and 64 and substr(${table.operation}, 1, 1) glob '[a-z]' and ${table.operation} not glob '*[^a-z0-9_]*'`,
    ),
    check(
      "operator_command_key",
      sql`length(${table.idempotencyKey}) between 22 and 128 and ${table.idempotencyKey} not glob '*[^ -~]*'`,
    ),
    check(
      "operator_command_profile",
      sql`${table.canonicalizationProfile} = 'command-json-v1'`,
    ),
    check(
      "operator_command_digest",
      sql`length(${table.requestDigest}) = 71 and ${table.requestDigest} glob 'sha256:[0-9a-f]*' and ${table.requestDigest} not glob 'sha256:*[^0-9a-f]*'`,
    ),
    check(
      "operator_command_response_status",
      sql`${table.responseStatus} between 200 and 599`,
    ),
    check(
      "operator_command_response_json",
      sql`json_valid(${table.responseBodyJson}) and length(cast(${table.responseBodyJson} as blob)) <= 1048576`,
    ),
    index("operator_command_created_at_idx").on(table.createdAt),
  ],
);

export const actions = sqliteTable(
  "actions",
  {
    id: text("id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    engagementId: text("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull(),
    state: text("state").notNull(),
    queuedSnapshotVersion: integer("queued_snapshot_version"),
    warningInteractions: integer("warning_interactions").notNull(),
    runState: text("run_state"),
    resumeRequested: integer("resume_requested", { mode: "boolean" }).notNull(),
    cleanupRequired: integer("cleanup_required", { mode: "boolean" }).notNull(),
    capabilityErrorCode: text("capability_error_code"),
    pendingWarningJson: text("pending_warning_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("action_contract_version", sql`${table.contractVersion} = 1`),
    check("action_revision_positive", sql`${table.revision} >= 1`),
    check(
      "action_id_length",
      sql`length(${table.id}) between 1 and 255`,
    ),
    check(
      "action_state",
      sql`${table.state} in ('planning', 'paused_for_warning', 'queued', 'active', 'active_paused_for_warning', 'succeeded', 'failed', 'cancelled', 'capability_error')`,
    ),
    check(
      "action_queued_snapshot_version",
      sql`${table.queuedSnapshotVersion} is null or ${table.queuedSnapshotVersion} >= 1`,
    ),
    check(
      "action_warning_interactions",
      sql`${table.warningInteractions} in (0, 1)`,
    ),
    check(
      "action_run_state",
      sql`${table.runState} is null or ${table.runState} in ('running', 'cancel_requested')`,
    ),
    check(
      "action_resume_boolean",
      sql`${table.resumeRequested} in (0, 1)`,
    ),
    check(
      "action_cleanup_boolean",
      sql`${table.cleanupRequired} in (0, 1)`,
    ),
    check(
      "action_capability_error",
      sql`${table.capabilityErrorCode} is null or ${table.capabilityErrorCode} in ('capability_error', 'required_resolution_unavailable', 'target_set_unrepresentable')`,
    ),
    check(
      "action_pending_warning_json",
      sql`${table.pendingWarningJson} is null or (json_valid(${table.pendingWarningJson}) and length(cast(${table.pendingWarningJson} as blob)) <= 1048576)`,
    ),
    uniqueIndex("action_engagement_id_unique").on(table.engagementId, table.id),
    index("action_engagement_created_idx").on(table.engagementId, table.createdAt),
  ],
);

export const actionSnapshots = sqliteTable(
  "action_snapshots",
  {
    id: text("id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    actionId: text("action_id").notNull(),
    engagementId: text("engagement_id").notNull(),
    version: integer("version").notNull(),
    binding: text("binding").notNull(),
    canonicalizationProfile: text("canonicalization_profile").notNull(),
    scopeRevisionId: text("scope_revision_id"),
    snapshotJson: text("snapshot_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("action_snapshot_contract_version", sql`${table.contractVersion} = 1`),
    check("action_snapshot_version_positive", sql`${table.version} >= 1`),
    check(
      "action_snapshot_id_length",
      sql`length(${table.id}) between 1 and 255`,
    ),
    check(
      "action_snapshot_profile",
      sql`${table.canonicalizationProfile} = 'action-snapshot-json-v1'`,
    ),
    check(
      "action_snapshot_binding",
      sql`length(${table.binding}) = 71 and ${table.binding} glob 'sha256:[0-9a-f]*' and ${table.binding} not glob 'sha256:*[^0-9a-f]*'`,
    ),
    check(
      "action_snapshot_json",
      sql`json_valid(${table.snapshotJson}) and length(cast(${table.snapshotJson} as blob)) <= 1048576`,
    ),
    uniqueIndex("action_snapshot_action_version_unique").on(
      table.actionId,
      table.version,
    ),
    uniqueIndex("action_snapshot_action_id_unique").on(table.actionId, table.id),
    uniqueIndex("action_snapshot_engagement_id_unique").on(
      table.engagementId,
      table.id,
    ),
    foreignKey({
      columns: [table.engagementId, table.actionId],
      foreignColumns: [actions.engagementId, actions.id],
      name: "action_snapshot_belongs_to_action",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.engagementId, table.scopeRevisionId],
      foreignColumns: [scopeRevisions.engagementId, scopeRevisions.id],
      name: "action_snapshot_scope_belongs_to_engagement",
    }).onDelete("restrict"),
  ],
);

export const actionWarningAcknowledgments = sqliteTable(
  "action_warning_acknowledgments",
  {
    id: text("id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    actionId: text("action_id").notNull(),
    engagementId: text("engagement_id").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    snapshotVersion: integer("snapshot_version").notNull(),
    snapshotBinding: text("snapshot_binding").notNull(),
    scopeRevisionId: text("scope_revision_id"),
    reasonCodesJson: text("reason_codes_json").notNull(),
    knownAdditionsJson: text("known_additions_json").notNull(),
    source: text("source").notNull(),
    acknowledgedAt: text("acknowledged_at").notNull(),
    pendingEventId: integer("pending_event_id"),
  },
  (table) => [
    check(
      "action_warning_acknowledgment_contract_version",
      sql`${table.contractVersion} = 1`,
    ),
    check(
      "action_warning_acknowledgment_id_length",
      sql`length(${table.id}) between 1 and 255`,
    ),
    check(
      "action_warning_acknowledgment_snapshot_version",
      sql`${table.snapshotVersion} >= 1`,
    ),
    check(
      "action_warning_acknowledgment_binding",
      sql`length(${table.snapshotBinding}) = 71 and ${table.snapshotBinding} glob 'sha256:[0-9a-f]*' and ${table.snapshotBinding} not glob 'sha256:*[^0-9a-f]*'`,
    ),
    check(
      "action_warning_acknowledgment_source",
      sql`${table.source} in ('operator_continue', 'add_scope_and_run', 'engagement_policy')`,
    ),
    check(
      "action_warning_acknowledgment_pending_event",
      sql`${table.pendingEventId} is null or ${table.pendingEventId} >= 1`,
    ),
    check(
      "action_warning_acknowledgment_reason_codes_json",
      sql`json_valid(${table.reasonCodesJson}) and length(cast(${table.reasonCodesJson} as blob)) <= 1048576`,
    ),
    check(
      "action_warning_acknowledgment_known_additions_json",
      sql`json_valid(${table.knownAdditionsJson}) and length(cast(${table.knownAdditionsJson} as blob)) <= 1048576`,
    ),
    uniqueIndex("action_warning_acknowledgment_action_unique").on(table.actionId),
    uniqueIndex("action_warning_acknowledgment_engagement_id_unique").on(
      table.engagementId,
      table.id,
    ),
    uniqueIndex("action_warning_acknowledgment_action_id_unique").on(
      table.actionId,
      table.id,
    ),
    foreignKey({
      columns: [table.engagementId, table.actionId],
      foreignColumns: [actions.engagementId, actions.id],
      name: "action_warning_acknowledgment_belongs_to_action",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.actionId, table.snapshotId],
      foreignColumns: [actionSnapshots.actionId, actionSnapshots.id],
      name: "action_warning_acknowledgment_binds_snapshot",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.engagementId, table.scopeRevisionId],
      foreignColumns: [scopeRevisions.engagementId, scopeRevisions.id],
      name: "action_warning_acknowledgment_scope_belongs_to_engagement",
    }).onDelete("restrict"),
  ],
);

export const actionCoveredDestinations = sqliteTable(
  "action_covered_destinations",
  {
    actionId: text("action_id").notNull(),
    engagementId: text("engagement_id").notNull(),
    acknowledgmentId: text("acknowledgment_id").notNull(),
    sequence: integer("sequence").notNull(),
    destinationJson: text("destination_json").notNull(),
    reasonCodesJson: text("reason_codes_json").notNull(),
    acknowledgedCover: integer("acknowledged_cover", {
      mode: "boolean",
    }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.actionId, table.sequence] }),
    check(
      "action_covered_destination_sequence",
      sql`${table.sequence} >= 1`,
    ),
    check(
      "action_covered_destination_ack_cover",
      sql`${table.acknowledgedCover} in (0, 1)`,
    ),
    check(
      "action_covered_destination_json",
      sql`json_valid(${table.destinationJson}) and length(cast(${table.destinationJson} as blob)) <= 1048576`,
    ),
    check(
      "action_covered_destination_reason_codes_json",
      sql`json_valid(${table.reasonCodesJson}) and length(cast(${table.reasonCodesJson} as blob)) <= 1048576`,
    ),
    foreignKey({
      columns: [table.engagementId, table.actionId],
      foreignColumns: [actions.engagementId, actions.id],
      name: "action_covered_destination_belongs_to_action",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.actionId, table.acknowledgmentId],
      foreignColumns: [
        actionWarningAcknowledgments.actionId,
        actionWarningAcknowledgments.id,
      ],
      name: "action_covered_destination_belongs_to_acknowledgment",
    }).onDelete("restrict"),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    actionId: text("action_id").notNull(),
    engagementId: text("engagement_id").notNull(),
    attempt: integer("attempt").notNull(),
    state: text("state", {
      enum: [
        "queued",
        "leased",
        "running",
        "cancel_requested",
        "succeeded",
        "failed",
        "cancelled",
      ],
    }).notNull(),
    currentLeaseId: text("current_lease_id"),
    currentFence: text("current_fence").notNull(),
    terminalKind: text("terminal_kind", {
      enum: ["succeeded", "failed", "cancelled"],
    }),
    terminalReason: text("terminal_reason"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("run_contract_version", sql`${table.contractVersion} = 1`),
    check("run_id_length", sql`length(${table.id}) between 1 and 255`),
    check(
      "run_attempt_safe_positive",
      sql`${table.attempt} between 1 and 9007199254740991`,
    ),
    check(
      "run_state",
      sql`${table.state} in ('queued', 'leased', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      "run_current_fence_canonical_int64",
      sql`length(${table.currentFence}) between 1 and 19 and ${table.currentFence} not glob '*[^0-9]*' and (${table.currentFence} = '0' or substr(${table.currentFence}, 1, 1) between '1' and '9') and (length(${table.currentFence}) < 19 or ${table.currentFence} <= '9223372036854775807')`,
    ),
    check(
      "run_positive_fence_after_queue",
      sql`${table.currentFence} <> '0' or ${table.state} in ('queued', 'cancelled')`,
    ),
    check(
      "run_terminal_fields",
      sql`(
        ${table.state} = 'succeeded' and ${table.terminalKind} = 'succeeded' and ${table.terminalReason} is null
      ) or (
        ${table.state} in ('failed', 'cancelled') and ${table.terminalKind} = ${table.state} and ${table.terminalReason} is not null
      ) or (
        ${table.state} not in ('succeeded', 'failed', 'cancelled') and ${table.terminalKind} is null and ${table.terminalReason} is null
      )`,
    ),
    check(
      "run_terminal_reason",
      sql`${table.terminalReason} is null or (length(${table.terminalReason}) between 1 and 64 and substr(${table.terminalReason}, 1, 1) glob '[a-z]' and ${table.terminalReason} not glob '*[^a-z0-9_]*')`,
    ),
    uniqueIndex("run_action_attempt_unique").on(table.actionId, table.attempt),
    uniqueIndex("run_engagement_id_unique").on(table.engagementId, table.id),
    uniqueIndex("run_action_nonterminal_unique")
      .on(table.actionId)
      .where(
        sql`${table.state} not in ('succeeded', 'failed', 'cancelled')`,
      ),
    index("run_queue_order_idx").on(table.state, table.createdAt, table.id),
    foreignKey({
      columns: [table.engagementId, table.actionId],
      foreignColumns: [actions.engagementId, actions.id],
      name: "run_belongs_to_action",
    }).onDelete("restrict"),
  ],
);

export const runLeases = sqliteTable(
  "run_leases",
  {
    leaseId: text("lease_id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    runnerId: text("runner_id").notNull(),
    sessionId: text("session_id").notNull(),
    fence: text("fence").notNull(),
    expiresAt: text("expires_at").notNull(),
    latestHeartbeatSequence: integer("latest_heartbeat_sequence").notNull(),
    latestEventSequence: integer("latest_event_sequence").notNull(),
    latestHeartbeatDigest: text("latest_heartbeat_digest"),
    current: integer("current", { mode: "boolean" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("run_lease_contract_version", sql`${table.contractVersion} = 1`),
    check(
      "run_lease_id_length",
      sql`length(${table.leaseId}) between 1 and 255`,
    ),
    check(
      "run_lease_runner_id_length",
      sql`length(${table.runnerId}) between 1 and 255`,
    ),
    check(
      "run_lease_session_id_length",
      sql`length(${table.sessionId}) between 1 and 255`,
    ),
    check(
      "run_lease_fence_canonical_int64",
      sql`length(${table.fence}) between 1 and 19 and ${table.fence} not glob '*[^0-9]*' and substr(${table.fence}, 1, 1) between '1' and '9' and (length(${table.fence}) < 19 or ${table.fence} <= '9223372036854775807')`,
    ),
    check(
      "run_lease_heartbeat_sequence",
      sql`${table.latestHeartbeatSequence} between 0 and 9007199254740991`,
    ),
    check(
      "run_lease_event_sequence",
      sql`${table.latestEventSequence} between 0 and 9007199254740991`,
    ),
    check(
      "run_lease_heartbeat_digest",
      sql`${table.latestHeartbeatDigest} is null or (length(${table.latestHeartbeatDigest}) = 71 and ${table.latestHeartbeatDigest} glob 'sha256:[0-9a-f]*' and ${table.latestHeartbeatDigest} not glob 'sha256:*[^0-9a-f]*')`,
    ),
    check("run_lease_current_boolean", sql`${table.current} in (0, 1)`),
    uniqueIndex("run_lease_run_fence_unique").on(table.runId, table.fence),
    uniqueIndex("run_lease_identity_unique").on(
      table.leaseId,
      table.runId,
      table.fence,
    ),
    uniqueIndex("run_lease_current_run_unique")
      .on(table.runId)
      .where(sql`${table.current} = 1`),
    index("run_lease_runner_current_idx").on(
      table.runnerId,
      table.sessionId,
      table.current,
      table.expiresAt,
    ),
  ],
);

export const runEvents = sqliteTable(
  "run_events",
  {
    eventId: integer("event_id").primaryKey({ autoIncrement: true }),
    contractVersion: integer("contract_version").notNull(),
    runId: text("run_id").notNull(),
    sequence: integer("sequence").notNull(),
    type: text("type", {
      enum: [
        "lease_acquired",
        "heartbeat",
        "started",
        "lease_expired",
        "succeeded",
        "failed",
        "cancelled",
      ],
    }).notNull(),
    fence: text("fence").notNull(),
    payloadJson: text("payload_json").notNull(),
    digest: text("digest").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("run_event_contract_version", sql`${table.contractVersion} = 1`),
    check(
      "run_event_id_safe_positive",
      sql`${table.eventId} between 1 and 9007199254740991`,
    ),
    check(
      "run_event_sequence_safe_positive",
      sql`${table.sequence} between 1 and 9007199254740991`,
    ),
    check(
      "run_event_type",
      sql`${table.type} in ('lease_acquired', 'heartbeat', 'started', 'lease_expired', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      "run_event_fence_canonical_int64",
      sql`length(${table.fence}) between 1 and 19 and ${table.fence} not glob '*[^0-9]*' and substr(${table.fence}, 1, 1) between '1' and '9' and (length(${table.fence}) < 19 or ${table.fence} <= '9223372036854775807')`,
    ),
    check(
      "run_event_payload_json",
      sql`json_valid(${table.payloadJson}) and length(cast(${table.payloadJson} as blob)) <= 1048576`,
    ),
    check(
      "run_event_digest",
      sql`length(${table.digest}) = 71 and ${table.digest} glob 'sha256:[0-9a-f]*' and ${table.digest} not glob 'sha256:*[^0-9a-f]*'`,
    ),
    uniqueIndex("run_event_run_type_sequence_unique").on(
      table.runId,
      table.fence,
      table.type,
      table.sequence,
    ),
    uniqueIndex("run_event_runner_sequence_unique")
      .on(table.runId, table.fence, table.sequence)
      .where(
        sql`${table.type} in ('started', 'succeeded', 'failed', 'cancelled')`,
      ),
    index("run_event_run_created_idx").on(table.runId, table.eventId),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [runs.id],
      name: "run_event_belongs_to_run",
    }).onDelete("restrict"),
  ],
);

export type EngagementRow = typeof engagements.$inferSelect;
export type EngagementNotesRow = typeof engagementNotes.$inferSelect;
export type ScopeRevisionRow = typeof scopeRevisions.$inferSelect;
export type OperatorCommandIdempotencyRow =
  typeof operatorCommandIdempotency.$inferSelect;
export type ActionRow = typeof actions.$inferSelect;
export type ActionSnapshotRow = typeof actionSnapshots.$inferSelect;
export type ActionWarningAcknowledgmentRow =
  typeof actionWarningAcknowledgments.$inferSelect;
export type ActionCoveredDestinationRow =
  typeof actionCoveredDestinations.$inferSelect;
export const runnerIdentities = sqliteTable(
  "runner_identities",
  {
    id: text("id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    revision: integer("revision").notNull(),
    name: text("name").notNull(),
    installationFingerprint: text("installation_fingerprint").notNull(),
    status: text("status", { enum: ["enabled", "revoked"] }).notNull(),
    saltHex: text("salt_hex").notNull(),
    verifierHex: text("verifier_hex").notNull(),
    kdf: text("kdf").notNull(),
    costN: integer("cost_n").notNull(),
    blockSizeR: integer("block_size_r").notNull(),
    parallelizationP: integer("parallelization_p").notNull(),
    verifierBytes: integer("verifier_bytes").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    check("runner_identity_contract_version", sql`${table.contractVersion} = 1`),
    check("runner_identity_revision_positive", sql`${table.revision} >= 1`),
    check(
      "runner_identity_id_length",
      sql`length(${table.id}) between 1 and 255`,
    ),
    check(
      "runner_identity_name_length",
      sql`length(${table.name}) between 1 and 120 and ${table.name} = trim(${table.name})`,
    ),
    check(
      "runner_identity_fingerprint",
      sql`length(${table.installationFingerprint}) = 71 and ${table.installationFingerprint} glob 'sha256:[0-9a-f]*' and ${table.installationFingerprint} not glob 'sha256:*[^0-9a-f]*'`,
    ),
    check(
      "runner_identity_status",
      sql`${table.status} in ('enabled', 'revoked')`,
    ),
    check(
      "runner_identity_salt_hex",
      sql`length(${table.saltHex}) = 64 and ${table.saltHex} not glob '*[^0-9a-f]*'`,
    ),
    check(
      "runner_identity_verifier_hex",
      sql`length(${table.verifierHex}) = 64 and ${table.verifierHex} not glob '*[^0-9a-f]*'`,
    ),
    check("runner_identity_kdf", sql`${table.kdf} = 'scrypt'`),
    check("runner_identity_cost_n", sql`${table.costN} = 16384`),
    check("runner_identity_block_size_r", sql`${table.blockSizeR} = 8`),
    check("runner_identity_parallelization_p", sql`${table.parallelizationP} = 1`),
    check("runner_identity_verifier_bytes", sql`${table.verifierBytes} = 32`),
    check(
      "runner_identity_revoked_at",
      sql`(${table.status} = 'enabled' and ${table.revokedAt} is null) or (${table.status} = 'revoked' and ${table.revokedAt} is not null)`,
    ),
    uniqueIndex("runner_identity_one_enabled")
      .on(table.status)
      .where(sql`${table.status} = 'enabled'`),
    index("runner_identity_status_created_idx").on(table.status, table.createdAt),
  ],
);

export const runnerEnrollmentChallenges = sqliteTable(
  "runner_enrollment_challenges",
  {
    id: text("id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    name: text("name").notNull(),
    installationFingerprint: text("installation_fingerprint").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
  },
  (table) => [
    check(
      "runner_enrollment_challenge_contract_version",
      sql`${table.contractVersion} = 1`,
    ),
    check(
      "runner_enrollment_challenge_id_length",
      sql`length(${table.id}) between 1 and 255`,
    ),
    check(
      "runner_enrollment_challenge_name_length",
      sql`length(${table.name}) between 1 and 120 and ${table.name} = trim(${table.name})`,
    ),
    check(
      "runner_enrollment_challenge_fingerprint",
      sql`length(${table.installationFingerprint}) = 71 and ${table.installationFingerprint} glob 'sha256:[0-9a-f]*' and ${table.installationFingerprint} not glob 'sha256:*[^0-9a-f]*'`,
    ),
    index("runner_enrollment_challenge_expires_idx").on(table.expiresAt),
  ],
);

export const runnerSessions = sqliteTable(
  "runner_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runnerIdentities.id, { onDelete: "restrict" }),
    protocol: text("protocol").notNull(),
    installationFingerprint: text("installation_fingerprint").notNull(),
    registryDigest: text("registry_digest"),
    eventSchemasJson: text("event_schemas_json").notNull(),
    current: integer("current", { mode: "boolean" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("runner_session_contract_version", sql`${table.contractVersion} = 1`),
    check(
      "runner_session_id_length",
      sql`length(${table.sessionId}) between 1 and 255`,
    ),
    check(
      "runner_session_runner_id_length",
      sql`length(${table.runnerId}) between 1 and 255`,
    ),
    check(
      "runner_session_protocol",
      sql`${table.protocol} = 'runner-control-v1'`,
    ),
    check(
      "runner_session_fingerprint",
      sql`length(${table.installationFingerprint}) = 71 and ${table.installationFingerprint} glob 'sha256:[0-9a-f]*' and ${table.installationFingerprint} not glob 'sha256:*[^0-9a-f]*'`,
    ),
    check(
      "runner_session_registry_digest",
      sql`${table.registryDigest} is null or (length(${table.registryDigest}) = 71 and ${table.registryDigest} glob 'sha256:[0-9a-f]*' and ${table.registryDigest} not glob 'sha256:*[^0-9a-f]*')`,
    ),
    check(
      "runner_session_event_schemas_json",
      sql`json_valid(${table.eventSchemasJson}) and length(cast(${table.eventSchemasJson} as blob)) <= 1048576`,
    ),
    check("runner_session_current_boolean", sql`${table.current} in (0, 1)`),
    uniqueIndex("runner_session_current_runner_unique")
      .on(table.runnerId)
      .where(sql`${table.current} = 1`),
    index("runner_session_runner_created_idx").on(table.runnerId, table.createdAt),
  ],
);

// D3 upload grants. One in-progress grant per durable artifact identity
// (runId, fence, eventSequence, artifactSlot); the identity binds
// latestEventSequence+1 without consuming the lease event cursor.
export const evidenceGrants = sqliteTable(
  "evidence_grants",
  {
    artifactId: text("artifact_id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    profile: text("profile").notNull(),
    uploadId: text("upload_id").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    leaseId: text("lease_id").notNull(),
    runnerId: text("runner_id").notNull(),
    sessionId: text("session_id").notNull(),
    fence: text("fence").notNull(),
    eventSequence: integer("event_sequence").notNull(),
    artifactSlot: text("artifact_slot").notNull(),
    kind: text("kind", {
      enum: ["stdout", "stderr", "tool_raw", "tool_parsed_input"],
    }).notNull(),
    declaredSizeBytes: integer("declared_size_bytes"),
    declaredDigest: text("declared_digest"),
    originalFileName: text("original_file_name"),
    declaredContentType: text("declared_content_type"),
    state: text("state", {
      enum: ["in_progress", "upload_interrupted", "published"],
    }).notNull(),
    reservationBytes: integer("reservation_bytes").notNull(),
    putFinalized: integer("put_finalized", { mode: "boolean" }).notNull(),
    acceptedBytes: integer("accepted_bytes").notNull(),
    streamedDigest: text("streamed_digest"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("evidence_grant_contract_version", sql`${table.contractVersion} = 1`),
    check("evidence_grant_profile", sql`${table.profile} = 'd3-v1'`),
    check(
      "evidence_grant_artifact_id",
      sql`length(${table.artifactId}) between 1 and 127 and substr(${table.artifactId}, 1, 1) glob '[a-z0-9]' and ${table.artifactId} not glob '*[^a-z0-9-]*'`,
    ),
    check(
      "evidence_grant_upload_id",
      sql`length(${table.uploadId}) between 1 and 127 and substr(${table.uploadId}, 1, 1) glob '[a-z0-9]' and ${table.uploadId} not glob '*[^a-z0-9-]*'`,
    ),
    check(
      "evidence_grant_artifact_slot",
      sql`length(${table.artifactSlot}) between 1 and 127 and substr(${table.artifactSlot}, 1, 1) glob '[a-z0-9]' and ${table.artifactSlot} not glob '*[^a-z0-9-]*'`,
    ),
    check(
      "evidence_grant_run_id_length",
      sql`length(${table.runId}) between 1 and 255`,
    ),
    check(
      "evidence_grant_lease_id_length",
      sql`length(${table.leaseId}) between 1 and 255`,
    ),
    check(
      "evidence_grant_runner_id_length",
      sql`length(${table.runnerId}) between 1 and 255`,
    ),
    check(
      "evidence_grant_session_id_length",
      sql`length(${table.sessionId}) between 1 and 255`,
    ),
    check(
      "evidence_grant_fence_canonical_int64",
      sql`length(${table.fence}) between 1 and 19 and ${table.fence} not glob '*[^0-9]*' and substr(${table.fence}, 1, 1) between '1' and '9' and (length(${table.fence}) < 19 or ${table.fence} <= '9223372036854775807')`,
    ),
    check(
      "evidence_grant_event_sequence",
      sql`${table.eventSequence} between 1 and 9007199254740991`,
    ),
    check(
      "evidence_grant_kind",
      sql`${table.kind} in ('stdout', 'stderr', 'tool_raw', 'tool_parsed_input')`,
    ),
    check(
      "evidence_grant_declared_size_bytes",
      sql`${table.declaredSizeBytes} is null or ${table.declaredSizeBytes} between 0 and 1073741824`,
    ),
    check(
      "evidence_grant_declared_digest",
      sql`${table.declaredDigest} is null or (length(${table.declaredDigest}) = 71 and ${table.declaredDigest} glob 'sha256:[0-9a-f]*' and ${table.declaredDigest} not glob 'sha256:*[^0-9a-f]*')`,
    ),
    check(
      "evidence_grant_original_file_name",
      sql`${table.originalFileName} is null or length(${table.originalFileName}) between 1 and 255`,
    ),
    check(
      "evidence_grant_declared_content_type",
      sql`${table.declaredContentType} is null or length(${table.declaredContentType}) between 1 and 127`,
    ),
    check(
      "evidence_grant_state",
      sql`${table.state} in ('in_progress', 'upload_interrupted', 'published')`,
    ),
    // Reservation upper bound follows the perArtifactBytes contract maximum,
    // not the default quota, so approved custom quotas stay representable.
    check(
      "evidence_grant_reservation_bytes",
      sql`${table.reservationBytes} between 1 and 1073741824`,
    ),
    check("evidence_grant_put_finalized", sql`${table.putFinalized} in (0, 1)`),
    check(
      "evidence_grant_accepted_bytes",
      sql`${table.acceptedBytes} between 0 and ${table.reservationBytes}`,
    ),
    check(
      "evidence_grant_streamed_digest",
      sql`${table.streamedDigest} is null or (length(${table.streamedDigest}) = 71 and ${table.streamedDigest} glob 'sha256:[0-9a-f]*' and ${table.streamedDigest} not glob 'sha256:*[^0-9a-f]*')`,
    ),
    uniqueIndex("evidence_grant_identity_in_progress_unique")
      .on(table.runId, table.fence, table.eventSequence, table.artifactSlot)
      .where(sql`${table.state} = 'in_progress'`),
    uniqueIndex("evidence_grant_upload_id_unique").on(table.uploadId),
    index("evidence_grant_runner_state_idx").on(table.runnerId, table.state),
    index("evidence_grant_run_state_idx").on(table.runId, table.state),
    index("evidence_grant_run_fence_sequence_idx").on(
      table.runId,
      table.fence,
      table.eventSequence,
    ),
  ],
);

// D3 published artifacts. Immutable durable identity bound to its Run;
// the unique key is (runId, fence, eventSequence, artifactSlot). Rows are
// inserted only after the published file and directory are fsynced.
export const evidenceArtifacts = sqliteTable(
  "evidence_artifacts",
  {
    artifactId: text("artifact_id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    profile: text("profile").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    fence: text("fence").notNull(),
    eventSequence: integer("event_sequence").notNull(),
    artifactSlot: text("artifact_slot").notNull(),
    kind: text("kind", {
      enum: ["stdout", "stderr", "tool_raw", "tool_parsed_input"],
    }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    digest: text("digest").notNull(),
    relativePath: text("relative_path").notNull(),
    completeness: text("completeness", {
      enum: ["complete", "partial", "truncated"],
    }).notNull(),
    redactionApplied: integer("redaction_applied", { mode: "boolean" }).notNull(),
    redactionBoundary: text("redaction_boundary", {
      enum: ["runner_stream", "none"],
    }).notNull(),
    rawBytesPreserved: integer("raw_bytes_preserved", { mode: "boolean" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("evidence_artifact_contract_version", sql`${table.contractVersion} = 1`),
    check("evidence_artifact_profile", sql`${table.profile} = 'd3-v1'`),
    check(
      "evidence_artifact_artifact_id",
      sql`length(${table.artifactId}) between 1 and 127 and substr(${table.artifactId}, 1, 1) glob '[a-z0-9]' and ${table.artifactId} not glob '*[^a-z0-9-]*'`,
    ),
    check(
      "evidence_artifact_run_id_length",
      sql`length(${table.runId}) between 1 and 255`,
    ),
    check(
      "evidence_artifact_fence_canonical_int64",
      sql`length(${table.fence}) between 1 and 19 and ${table.fence} not glob '*[^0-9]*' and substr(${table.fence}, 1, 1) between '1' and '9' and (length(${table.fence}) < 19 or ${table.fence} <= '9223372036854775807')`,
    ),
    check(
      "evidence_artifact_event_sequence",
      sql`${table.eventSequence} between 1 and 9007199254740991`,
    ),
    check(
      "evidence_artifact_artifact_slot",
      sql`length(${table.artifactSlot}) between 1 and 127 and substr(${table.artifactSlot}, 1, 1) glob '[a-z0-9]' and ${table.artifactSlot} not glob '*[^a-z0-9-]*'`,
    ),
    check(
      "evidence_artifact_kind",
      sql`${table.kind} in ('stdout', 'stderr', 'tool_raw', 'tool_parsed_input')`,
    ),
    check(
      "evidence_artifact_size_bytes",
      sql`${table.sizeBytes} between 0 and 1073741824`,
    ),
    check(
      "evidence_artifact_digest",
      sql`length(${table.digest}) = 71 and ${table.digest} glob 'sha256:[0-9a-f]*' and ${table.digest} not glob 'sha256:*[^0-9a-f]*'`,
    ),
    check(
      "evidence_artifact_relative_path",
      sql`${table.relativePath} = 'published/' || ${table.artifactId}`,
    ),
    check(
      "evidence_artifact_completeness",
      sql`${table.completeness} in ('complete', 'partial', 'truncated')`,
    ),
    check(
      "evidence_artifact_redaction_flags",
      sql`${table.redactionApplied} in (0, 1) and ${table.redactionBoundary} in ('runner_stream', 'none') and ${table.rawBytesPreserved} in (0, 1)`,
    ),
    check(
      "evidence_artifact_redaction_tuple",
      sql`(
        ${table.kind} in ('stdout', 'stderr') and
        ${table.redactionApplied} = 1 and
        ${table.redactionBoundary} = 'runner_stream' and
        ${table.rawBytesPreserved} = 0
      ) or (
        ${table.kind} in ('tool_raw', 'tool_parsed_input') and
        ${table.redactionApplied} = 0 and
        ${table.redactionBoundary} = 'none' and
        ${table.rawBytesPreserved} = 1
      )`,
    ),
    uniqueIndex("evidence_artifact_identity_unique").on(
      table.runId,
      table.fence,
      table.eventSequence,
      table.artifactSlot,
    ),
    index("evidence_artifact_run_created_idx").on(table.runId, table.createdAt),
  ],
);

export const nmapServices = sqliteTable(
  "nmap_services",
  {
    artifactId: text("artifact_id").notNull(),
    parserVersion: text("parser_version").notNull(),
    address: text("address").notNull(),
    port: integer("port").notNull(),
    protocol: text("protocol", { enum: ["tcp"] }).notNull(),
    hostname: text("hostname"),
    serviceName: text("service_name"),
    product: text("product"),
    version: text("version"),
    observedAt: text("observed_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.artifactId, table.parserVersion, table.address, table.port, table.protocol],
    }),
    foreignKey({
      columns: [table.artifactId],
      foreignColumns: [evidenceArtifacts.artifactId],
      name: "nmap_service_artifact_fk",
    }).onDelete("restrict"),
    check(
      "nmap_service_artifact_id",
      sql`length(${table.artifactId}) between 1 and 127
        and substr(${table.artifactId},1,1) glob '[a-z0-9]'
        and ${table.artifactId} not glob '*[^a-z0-9-]*'`,
    ),
    check(
      "nmap_service_parser_version",
      sql`length(${table.parserVersion}) between 1 and 64
        and ${table.parserVersion} not glob '*[^a-z0-9._-]*'
        and substr(${table.parserVersion}, 1, 1) glob '[a-z0-9]'`,
    ),
    check("nmap_service_address", sql`length(${table.address}) between 1 and 45`),
    check("nmap_service_port", sql`${table.port} between 1 and 65535`),
    check("nmap_service_protocol", sql`${table.protocol} = 'tcp'`),
    check(
      "nmap_service_hostname",
      sql`${table.hostname} is null or length(${table.hostname}) between 1 and 253`,
    ),
    check(
      "nmap_service_service_name",
      sql`${table.serviceName} is null or length(${table.serviceName}) between 1 and 64`,
    ),
    check(
      "nmap_service_product",
      sql`${table.product} is null or length(${table.product}) between 1 and 64`,
    ),
    check(
      "nmap_service_version",
      sql`${table.version} is null or length(${table.version}) between 1 and 64`,
    ),
    check("nmap_service_observed_at", sql`length(${table.observedAt}) >= 20`),
  ],
);

export const httpProbeResults = sqliteTable(
  "http_probe_results",
  {
    artifactId: text("artifact_id").notNull(),
    parserVersion: text("parser_version").notNull(),
    url: text("url").notNull(),
    finalUrl: text("final_url").notNull(),
    status: integer("status"),
    title: text("title"),
    contentType: text("content_type"),
    server: text("server"),
    poweredBy: text("powered_by"),
    hopsJson: text("hops_json").notNull(),
    probeError: text("probe_error"),
    observedAt: text("observed_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.artifactId, table.parserVersion, table.url],
    }),
    foreignKey({
      columns: [table.artifactId],
      foreignColumns: [evidenceArtifacts.artifactId],
      name: "http_probe_result_artifact_fk",
    }).onDelete("restrict"),
    check(
      "http_probe_result_artifact_id",
      sql`length(${table.artifactId}) between 1 and 127
        and substr(${table.artifactId},1,1) glob '[a-z0-9]'
        and ${table.artifactId} not glob '*[^a-z0-9-]*'`,
    ),
    check(
      "http_probe_result_parser_version",
      sql`length(${table.parserVersion}) between 1 and 64
        and ${table.parserVersion} not glob '*[^a-z0-9._-]*'
        and substr(${table.parserVersion}, 1, 1) glob '[a-z0-9]'`,
    ),
    check(
      "http_probe_result_url",
      sql`length(${table.url}) between 1 and 2048`,
    ),
    check(
      "http_probe_result_final_url",
      sql`length(${table.finalUrl}) between 1 and 2048`,
    ),
    check(
      "http_probe_result_status",
      sql`${table.status} is null or (${table.status} between 100 and 599)`,
    ),
    check(
      "http_probe_result_title",
      sql`${table.title} is null or length(${table.title}) between 1 and 256`,
    ),
    check(
      "http_probe_result_hops_json",
      sql`json_valid(${table.hopsJson}) and length(cast(${table.hopsJson} as blob)) <= 65536`,
    ),
    check("http_probe_result_observed_at", sql`length(${table.observedAt}) >= 20`),
  ],
);

export const ffufResults = sqliteTable(
  "ffuf_results",
  {
    artifactId: text("artifact_id").notNull(),
    parserVersion: text("parser_version").notNull(),
    url: text("url").notNull(),
    status: integer("status").notNull(),
    length: integer("length").notNull(),
    words: integer("words").notNull(),
    lines: integer("lines").notNull(),
    redirectlocation: text("redirectlocation"),
    fuzz: text("fuzz").notNull(),
    observedAt: text("observed_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.artifactId, table.parserVersion, table.url],
    }),
    foreignKey({
      columns: [table.artifactId],
      foreignColumns: [evidenceArtifacts.artifactId],
      name: "ffuf_result_artifact_fk",
    }).onDelete("restrict"),
    check(
      "ffuf_result_artifact_id",
      sql`length(${table.artifactId}) between 1 and 127
        and substr(${table.artifactId},1,1) glob '[a-z0-9]'
        and ${table.artifactId} not glob '*[^a-z0-9-]*'`,
    ),
    check(
      "ffuf_result_parser_version",
      sql`length(${table.parserVersion}) between 1 and 64
        and ${table.parserVersion} not glob '*[^a-z0-9._-]*'
        and substr(${table.parserVersion}, 1, 1) glob '[a-z0-9]'`,
    ),
    check(
      "ffuf_result_url",
      sql`length(${table.url}) between 1 and 2048`,
    ),
    check(
      "ffuf_result_status",
      sql`${table.status} between 100 and 599`,
    ),
    check(
      "ffuf_result_counts",
      sql`${table.length} >= 0 and ${table.words} >= 0 and ${table.lines} >= 0`,
    ),
    check(
      "ffuf_result_redirect",
      sql`${table.redirectlocation} is null or length(${table.redirectlocation}) between 1 and 2048`,
    ),
    check(
      "ffuf_result_fuzz",
      sql`length(${table.fuzz}) between 1 and 2048`,
    ),
    check("ffuf_result_observed_at", sql`length(${table.observedAt}) >= 20`),
  ],
);

export const findings = sqliteTable(
  "findings",
  {
    id: text("id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    engagementId: text("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    severity: text("severity", {
      enum: ["info", "low", "medium", "high", "critical"],
    }).notNull(),
    status: text("status", { enum: ["open", "resolved"] }).notNull(),
    body: text("body").notNull(),
    evidenceArtifactIdsJson: text("evidence_artifact_ids_json").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("finding_contract_version", sql`${table.contractVersion} = 1`),
    check(
      "finding_title_length",
      sql`length(${table.title}) between 1 and 120 and ${table.title} = trim(${table.title})`,
    ),
    check(
      "finding_severity",
      sql`${table.severity} in ('info', 'low', 'medium', 'high', 'critical')`,
    ),
    check(
      "finding_status",
      sql`${table.status} in ('open', 'resolved')`,
    ),
    check(
      "finding_body_bytes",
      sql`length(cast(${table.body} as blob)) <= 65536`,
    ),
    check(
      "finding_evidence_json",
      sql`json_valid(${table.evidenceArtifactIdsJson}) and length(cast(${table.evidenceArtifactIdsJson} as blob)) <= 8192`,
    ),
    check("finding_revision", sql`${table.revision} >= 1`),
    check("finding_created_at", sql`length(${table.createdAt}) >= 20`),
    check("finding_updated_at", sql`length(${table.updatedAt}) >= 20`),
    index("finding_engagement_created_idx").on(
      table.engagementId,
      table.createdAt,
      table.id,
    ),
  ],
);

// Advisor explanation turns (P3a storage/reservation only). No raw provider
// payload, no mode, no free-form audit: bounded redacted question, derived
// terminal output or a bounded safe error code, supplied evidence ids, and
// minimal metadata. Rows are append-only; terminal states never change.
export const advisorTurns = sqliteTable(
  "advisor_turns",
  {
    id: text("id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    engagementId: text("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "restrict" }),
    status: text("status", {
      enum: ["pending", "succeeded", "parse_error", "provider_error", "cancelled", "expired"],
    }).notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    uncertainty: text("uncertainty").notNull(),
    // Explicit abstention boolean for succeeded turns, null otherwise. P1
    // allows abstained answers with partial text and citations, so the flag
    // can never be inferred from blank fields.
    abstained: integer("abstained", { mode: "boolean" }),
    citationsJson: text("citations_json").notNull(),
    suppliedIdsJson: text("supplied_ids_json").notNull(),
    redactions: integer("redactions").notNull(),
    modelId: text("model_id").notNull(),
    errorCode: text("error_code"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("advisor_turn_contract_version", sql`${table.contractVersion} = 1`),
    check(
      "advisor_turn_status",
      sql`${table.status} in ('pending', 'succeeded', 'parse_error', 'provider_error', 'cancelled', 'expired')`,
    ),
    check(
      "advisor_turn_question_bytes",
      sql`length(cast(${table.question} as blob)) between 1 and 2000`,
    ),
    check(
      "advisor_turn_answer_bytes",
      sql`length(cast(${table.answer} as blob)) <= 8000`,
    ),
    check(
      "advisor_turn_uncertainty_bytes",
      sql`length(cast(${table.uncertainty} as blob)) <= 2000`,
    ),
    check(
      "advisor_turn_abstained",
      sql`(${table.status} = 'succeeded' and ${table.abstained} in (0, 1)) or (${table.status} <> 'succeeded' and ${table.abstained} is null)`,
    ),
    check(
      "advisor_turn_citations_json",
      sql`json_valid(${table.citationsJson}) and length(cast(${table.citationsJson} as blob)) <= 8192`,
    ),
    check(
      "advisor_turn_supplied_ids_json",
      sql`json_valid(${table.suppliedIdsJson}) and length(cast(${table.suppliedIdsJson} as blob)) <= 8192`,
    ),
    check("advisor_turn_redactions", sql`${table.redactions} >= 0`),
    check(
      "advisor_turn_model_id",
      sql`length(${table.modelId}) between 1 and 128`,
    ),
    check(
      "advisor_turn_error_code",
      sql`${table.errorCode} is null or ${table.errorCode} in ('provider_timeout', 'provider_unreachable', 'provider_response_too_large', 'provider_redirect_rejected', 'provider_parse_error', 'context_too_large')`,
    ),
    check(
      "advisor_turn_idempotency_key",
      sql`length(${table.idempotencyKey}) between 22 and 128 and ${table.idempotencyKey} not glob '*[^ -~]*'`,
    ),
    check(
      "advisor_turn_request_digest",
      sql`length(${table.requestDigest}) = 71 and ${table.requestDigest} glob 'sha256:[0-9a-f]*' and ${table.requestDigest} not glob 'sha256:*[^0-9a-f]*'`,
    ),
    check("advisor_turn_created_at", sql`length(${table.createdAt}) >= 20`),
    check("advisor_turn_updated_at", sql`length(${table.updatedAt}) >= 20`),
    uniqueIndex("advisor_turn_engagement_key_unique").on(
      table.engagementId,
      table.idempotencyKey,
    ),
    index("advisor_turn_engagement_created_idx").on(
      table.engagementId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const settings = sqliteTable(
  "settings",
  {
    scope: text("scope").primaryKey(),
    valueJson: text("value_json").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("settings_scope", sql`${table.scope} in ('runner', 'advisor')`),
    check(
      "settings_value_json",
      sql`json_valid(${table.valueJson}) and length(cast(${table.valueJson} as blob)) <= 65536`,
    ),
    check("settings_updated_at", sql`length(${table.updatedAt}) >= 20`),
  ],
);

// STONE-3 evidence excerpts: masked, bounded selections of preserved run
// output with a server-verified stable reference (run, artifact, digest,
// byte range). Content is masked at creation; raw bytes live only in the
// managed evidence store.
export const evidenceExcerpts = sqliteTable(
  "evidence_excerpts",
  {
    id: text("id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    engagementId: text("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "restrict" }),
    runId: text("run_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    artifactDigest: text("artifact_digest").notNull(),
    stream: text("stream", { enum: ["stdout", "stderr"] }).notNull(),
    byteOffset: integer("byte_offset").notNull(),
    byteLength: integer("byte_length").notNull(),
    content: text("content").notNull(),
    redactions: integer("redactions").notNull(),
    targetNote: text("target_note"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("evidence_excerpt_contract_version", sql`${table.contractVersion} = 1`),
    check(
      "evidence_excerpt_artifact_id",
      sql`length(${table.artifactId}) between 1 and 127 and substr(${table.artifactId}, 1, 1) glob '[a-z0-9]' and ${table.artifactId} not glob '*[^a-z0-9-]*'`,
    ),
    check(
      "evidence_excerpt_artifact_digest",
      sql`length(${table.artifactDigest}) = 71 and ${table.artifactDigest} glob 'sha256:[0-9a-f]*' and ${table.artifactDigest} not glob 'sha256:*[^0-9a-f]*'`,
    ),
    check("evidence_excerpt_stream", sql`${table.stream} in ('stdout', 'stderr')`),
    check(
      "evidence_excerpt_range",
      sql`${table.byteOffset} >= 0 and ${table.byteLength} between 1 and 8192 and ${table.byteOffset} + ${table.byteLength} <= 1073741824`,
    ),
    check(
      "evidence_excerpt_content_bytes",
      sql`length(cast(${table.content} as blob)) <= 16384`,
    ),
    check("evidence_excerpt_redactions", sql`${table.redactions} >= 0`),
    check(
      "evidence_excerpt_target_note",
      sql`${table.targetNote} is null or length(${table.targetNote}) between 1 and 120`,
    ),
    check("evidence_excerpt_created_at", sql`length(${table.createdAt}) >= 20`),
    index("evidence_excerpt_engagement_created_idx").on(
      table.engagementId,
      table.createdAt,
      table.id,
    ),
    index("evidence_excerpt_run_idx").on(table.engagementId, table.runId),
  ],
);

// STONE-3 note attachments: pasted or dropped images with a caption, an
// optional operator target label, and derivation lineage. Derived crops and
// annotations reference the kept original through parentAttachmentId;
// originals are never mutated by derivation.
// Bound note: content_base64 is capped at 2000000 chars while size_bytes
// allows 2000000 raw bytes, so base64 inflation makes the content CHECK bite
// first: the effective raw cap through the API is about 1.5M bytes.
export const evidenceAttachments = sqliteTable(
  "evidence_attachments",
  {
    id: text("id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    engagementId: text("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "restrict" }),
    filename: text("filename").notNull(),
    mime: text("mime", {
      enum: ["image/png", "image/jpeg", "image/gif", "image/webp"],
    }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    digest: text("digest").notNull(),
    caption: text("caption").notNull(),
    targetLabel: text("target_label"),
    parentAttachmentId: text("parent_attachment_id"),
    cropRectJson: text("crop_rect_json"),
    contentBase64: text("content_base64").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("evidence_attachment_contract_version", sql`${table.contractVersion} = 1`),
    check(
      "evidence_attachment_filename",
      sql`length(${table.filename}) between 1 and 128 and ${table.filename} not glob '*[^a-z0-9-]*'`,
    ),
    check(
      "evidence_attachment_mime",
      sql`${table.mime} in ('image/png', 'image/jpeg', 'image/gif', 'image/webp')`,
    ),
    check(
      "evidence_attachment_size_bytes",
      sql`${table.sizeBytes} between 1 and 2000000`,
    ),
    check(
      "evidence_attachment_digest",
      sql`length(${table.digest}) = 71 and ${table.digest} glob 'sha256:[0-9a-f]*' and ${table.digest} not glob 'sha256:*[^0-9a-f]*'`,
    ),
    check(
      "evidence_attachment_caption",
      sql`length(${table.caption}) <= 280`,
    ),
    check(
      "evidence_attachment_target_label",
      sql`${table.targetLabel} is null or length(${table.targetLabel}) between 1 and 120`,
    ),
    check(
      "evidence_attachment_crop_json",
      sql`${table.cropRectJson} is null or (json_valid(${table.cropRectJson}) and length(cast(${table.cropRectJson} as blob)) <= 1024)`,
    ),
    check(
      "evidence_attachment_content_bytes",
      sql`length(cast(${table.contentBase64} as blob)) between 1 and 2000000`,
    ),
    check("evidence_attachment_created_at", sql`length(${table.createdAt}) >= 20`),
    foreignKey({
      columns: [table.parentAttachmentId],
      foreignColumns: [table.id],
      name: "evidence_attachment_parent_fk",
    }).onDelete("restrict"),
    index("evidence_attachment_engagement_created_idx").on(
      table.engagementId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type RunRow = typeof runs.$inferSelect;
export type RunLeaseRow = typeof runLeases.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;
export type RunnerIdentityRow = typeof runnerIdentities.$inferSelect;
export type RunnerEnrollmentChallengeRow =
  typeof runnerEnrollmentChallenges.$inferSelect;
export type RunnerSessionRow = typeof runnerSessions.$inferSelect;
export type EvidenceGrantRow = typeof evidenceGrants.$inferSelect;
export type EvidenceArtifactRow = typeof evidenceArtifacts.$inferSelect;
export type NmapServiceRow = typeof nmapServices.$inferSelect;
export type HttpProbeResultRow = typeof httpProbeResults.$inferSelect;
export type FfufResultRow = typeof ffufResults.$inferSelect;
export type FindingRow = typeof findings.$inferSelect;
export type EvidenceExcerptRow = typeof evidenceExcerpts.$inferSelect;
export type EvidenceAttachmentRow = typeof evidenceAttachments.$inferSelect;
export type AdvisorTurnRow = typeof advisorTurns.$inferSelect;
export type SettingsRow = typeof settings.$inferSelect;

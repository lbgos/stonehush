CREATE TABLE `leads` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_version` integer NOT NULL,
	`engagement_id` text NOT NULL,
	`title` text NOT NULL,
	`target` text,
	`service_ref` text,
	`source_kind` text NOT NULL,
	`source_ref` text NOT NULL,
	`source_label` text,
	`next_step` text,
	`disposition` text NOT NULL,
	`park_reason` text,
	`tested_conditions` text,
	`closed_note` text,
	`revisit_trigger` text,
	`revisit_reason` text,
	`revisit_created_at` text,
	`revisit_dismissed` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`engagement_id`) REFERENCES `engagements`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "lead_contract_version" CHECK("leads"."contract_version" = 1),
	CONSTRAINT "lead_title_length" CHECK(length("leads"."title") between 1 and 120 and "leads"."title" = trim("leads"."title")),
	CONSTRAINT "lead_target_length" CHECK("leads"."target" is null or (length("leads"."target") between 1 and 253 and "leads"."target" = trim("leads"."target"))),
	CONSTRAINT "lead_service_ref_length" CHECK("leads"."service_ref" is null or (length("leads"."service_ref") between 1 and 253 and "leads"."service_ref" = trim("leads"."service_ref"))),
	CONSTRAINT "lead_source_kind" CHECK("leads"."source_kind" in ('nmap_service', 'http_probe', 'ffuf_result', 'run_output', 'manual')),
	CONSTRAINT "lead_source_ref_length" CHECK(length("leads"."source_ref") between 1 and 2048),
	CONSTRAINT "lead_source_label_length" CHECK("leads"."source_label" is null or length("leads"."source_label") between 1 and 120),
	CONSTRAINT "lead_next_step_length" CHECK("leads"."next_step" is null or length("leads"."next_step") between 1 and 500),
	CONSTRAINT "lead_disposition" CHECK("leads"."disposition" in ('open', 'parked', 'closed')),
	CONSTRAINT "lead_park_reason_present" CHECK(("leads"."disposition" = 'parked' and "leads"."park_reason" is not null and length("leads"."park_reason") between 1 and 500) or ("leads"."disposition" <> 'parked' and "leads"."park_reason" is null)),
	CONSTRAINT "lead_tested_conditions_length" CHECK("leads"."tested_conditions" is null or length("leads"."tested_conditions") between 1 and 500),
	CONSTRAINT "lead_closed_note_present" CHECK("leads"."closed_note" is null or ("leads"."disposition" = 'closed' and length("leads"."closed_note") between 1 and 500)),
	CONSTRAINT "lead_revisit_tuple" CHECK(("leads"."revisit_trigger" is null and "leads"."revisit_reason" is null and "leads"."revisit_created_at" is null) or ("leads"."revisit_trigger" in ('new_access', 'hostname_change', 'service_change') and "leads"."revisit_reason" is not null and length("leads"."revisit_reason") between 1 and 500 and "leads"."revisit_created_at" is not null and length("leads"."revisit_created_at") >= 20)),
	CONSTRAINT "lead_revisit_parked_only" CHECK("leads"."revisit_trigger" is null or "leads"."disposition" = 'parked'),
	CONSTRAINT "lead_revisit_dismissed_boolean" CHECK("leads"."revisit_dismissed" in (0, 1)),
	CONSTRAINT "lead_created_at" CHECK(length("leads"."created_at") >= 20),
	CONSTRAINT "lead_updated_at" CHECK(length("leads"."updated_at") >= 20)
);
--> statement-breakpoint
CREATE INDEX `lead_engagement_created_idx` ON `leads` (`engagement_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TABLE `lead_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_version` integer NOT NULL,
	`engagement_id` text NOT NULL,
	`lead_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`summary` text NOT NULL,
	`outcome` text NOT NULL,
	`conditions` text,
	`evidence_artifact_ids_json` text NOT NULL,
	`linked_finding_id` text,
	`linked_objective_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`engagement_id`) REFERENCES `engagements`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "lead_attempt_contract_version" CHECK("lead_attempts"."contract_version" = 1),
	CONSTRAINT "lead_attempt_sequence" CHECK("lead_attempts"."sequence" >= 1),
	CONSTRAINT "lead_attempt_summary_length" CHECK(length("lead_attempts"."summary") between 1 and 2000 and "lead_attempts"."summary" = trim("lead_attempts"."summary")),
	CONSTRAINT "lead_attempt_outcome" CHECK("lead_attempts"."outcome" in ('observed', 'ruled_out', 'inconclusive', 'interrupted')),
	CONSTRAINT "lead_attempt_conditions_length" CHECK("lead_attempts"."conditions" is null or length("lead_attempts"."conditions") between 1 and 500),
	CONSTRAINT "lead_attempt_evidence_json" CHECK(json_valid("lead_attempts"."evidence_artifact_ids_json") and length(cast("lead_attempts"."evidence_artifact_ids_json" as blob)) <= 8192),
	CONSTRAINT "lead_attempt_created_at" CHECK(length("lead_attempts"."created_at") >= 20)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lead_attempt_lead_sequence_unique` ON `lead_attempts` (`lead_id`,`sequence`);
--> statement-breakpoint
CREATE UNIQUE INDEX `lead_attempt_engagement_id_unique` ON `lead_attempts` (`engagement_id`,`id`);
--> statement-breakpoint
CREATE INDEX `lead_attempt_lead_created_idx` ON `lead_attempts` (`lead_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TABLE `objectives` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_version` integer NOT NULL,
	`engagement_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`proof_hint` text,
	`proof_digest` text,
	`captured_at` text,
	`submitted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`engagement_id`) REFERENCES `engagements`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "objective_contract_version" CHECK("objectives"."contract_version" = 1),
	CONSTRAINT "objective_name_length" CHECK(length("objectives"."name") between 1 and 120 and "objectives"."name" = trim("objectives"."name")),
	CONSTRAINT "objective_kind" CHECK("objectives"."kind" in ('user_flag', 'root_flag', 'single_proof', 'custom')),
	CONSTRAINT "objective_state" CHECK("objectives"."state" in ('open', 'captured', 'submitted')),
	CONSTRAINT "objective_proof_tuple" CHECK(("objectives"."state" = 'open' and "objectives"."proof_hint" is null and "objectives"."proof_digest" is null and "objectives"."captured_at" is null and "objectives"."submitted_at" is null) or ("objectives"."state" = 'captured' and "objectives"."proof_hint" is not null and "objectives"."proof_digest" is not null and "objectives"."captured_at" is not null and "objectives"."submitted_at" is null) or ("objectives"."state" = 'submitted' and "objectives"."proof_hint" is not null and "objectives"."proof_digest" is not null and "objectives"."captured_at" is not null and "objectives"."submitted_at" is not null)),
	CONSTRAINT "objective_proof_digest" CHECK("objectives"."proof_digest" is null or ("objectives"."proof_digest" glob 'sha256:[0-9a-f]*' and length("objectives"."proof_digest") = 71)),
	CONSTRAINT "objective_created_at" CHECK(length("objectives"."created_at") >= 20),
	CONSTRAINT "objective_updated_at" CHECK(length("objectives"."updated_at") >= 20)
);
--> statement-breakpoint
CREATE INDEX `objective_engagement_created_idx` ON `objectives` (`engagement_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_version` integer NOT NULL,
	`engagement_id` text NOT NULL,
	`label` text NOT NULL,
	`username` text,
	`service_ref` text NOT NULL,
	`secret_ref` text NOT NULL,
	`hint` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`engagement_id`) REFERENCES `engagements`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "secret_contract_version" CHECK("secrets"."contract_version" = 1),
	CONSTRAINT "secret_label_length" CHECK(length("secrets"."label") between 1 and 120 and "secrets"."label" = trim("secrets"."label")),
	CONSTRAINT "secret_username_length" CHECK("secrets"."username" is null or length("secrets"."username") between 1 and 253),
	CONSTRAINT "secret_ref_length" CHECK(length("secrets"."secret_ref") between 1 and 253 and "secrets"."secret_ref" = trim("secrets"."secret_ref")),
	CONSTRAINT "secret_service_ref_length" CHECK(length("secrets"."service_ref") between 1 and 253 and "secrets"."service_ref" = trim("secrets"."service_ref")),
	CONSTRAINT "secret_hint_length" CHECK("secrets"."hint" is null or length("secrets"."hint") between 1 and 64),
	CONSTRAINT "secret_created_at" CHECK(length("secrets"."created_at") >= 20),
	CONSTRAINT "secret_updated_at" CHECK(length("secrets"."updated_at") >= 20)
);
--> statement-breakpoint
CREATE INDEX `secret_engagement_created_idx` ON `secrets` (`engagement_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TABLE `secret_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_version` integer NOT NULL,
	`engagement_id` text NOT NULL,
	`secret_id` text NOT NULL,
	`result` text NOT NULL,
	`method` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`engagement_id`) REFERENCES `engagements`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`secret_id`) REFERENCES `secrets`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "secret_verification_contract_version" CHECK("secret_verifications"."contract_version" = 1),
	CONSTRAINT "secret_verification_result" CHECK("secret_verifications"."result" in ('verified', 'failed')),
	CONSTRAINT "secret_verification_method_length" CHECK(length("secret_verifications"."method") between 1 and 120 and "secret_verifications"."method" = trim("secret_verifications"."method")),
	CONSTRAINT "secret_verification_note_length" CHECK("secret_verifications"."note" is null or length("secret_verifications"."note") between 1 and 500),
	CONSTRAINT "secret_verification_created_at" CHECK(length("secret_verifications"."created_at") >= 20)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secret_verification_engagement_id_unique` ON `secret_verifications` (`engagement_id`,`id`);
--> statement-breakpoint
CREATE INDEX `secret_verification_secret_created_idx` ON `secret_verifications` (`secret_id`,`created_at`,`id`);

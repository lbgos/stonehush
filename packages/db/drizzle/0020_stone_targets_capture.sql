CREATE TABLE `stone_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_version` integer NOT NULL,
	`engagement_id` text NOT NULL,
	`label` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`engagement_id`) REFERENCES `engagements`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "stone_target_contract_version" CHECK("stone_targets"."contract_version" = 1),
	CONSTRAINT "stone_target_revision_positive" CHECK("stone_targets"."revision" >= 1),
	CONSTRAINT "stone_target_label_length" CHECK(length("stone_targets"."label") between 1 and 120 and "stone_targets"."label" = trim("stone_targets"."label")),
	CONSTRAINT "stone_target_created_at" CHECK(length("stone_targets"."created_at") >= 20),
	CONSTRAINT "stone_target_updated_at" CHECK(length("stone_targets"."updated_at") >= 20)
);
--> statement-breakpoint
CREATE INDEX `stone_target_engagement_created_idx` ON `stone_targets` (`engagement_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `stone_address_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_version` integer NOT NULL,
	`engagement_id` text NOT NULL,
	`target_id` text NOT NULL,
	`binding_kind` text NOT NULL,
	`address_text` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`superseded_at` text,
	FOREIGN KEY (`engagement_id`) REFERENCES `engagements`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_id`) REFERENCES `stone_targets`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "stone_binding_contract_version" CHECK("stone_address_bindings"."contract_version" = 1),
	CONSTRAINT "stone_binding_kind" CHECK("stone_address_bindings"."binding_kind" in ('ip', 'hostname')),
	CONSTRAINT "stone_binding_status" CHECK("stone_address_bindings"."status" in ('current', 'historical')),
	CONSTRAINT "stone_binding_address_length" CHECK(length("stone_address_bindings"."address_text") between 1 and 512),
	CONSTRAINT "stone_binding_created_at" CHECK(length("stone_address_bindings"."created_at") >= 20),
	CONSTRAINT "stone_binding_superseded_at" CHECK(("stone_address_bindings"."status" = 'current' and "stone_address_bindings"."superseded_at" is null) or ("stone_address_bindings"."status" = 'historical' and "stone_address_bindings"."superseded_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stone_binding_current_target_unique` ON `stone_address_bindings` (`target_id`) WHERE "stone_address_bindings"."status" = 'current';
--> statement-breakpoint
CREATE INDEX `stone_binding_target_created_idx` ON `stone_address_bindings` (`target_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `stone_hostname_associations` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_version` integer NOT NULL,
	`engagement_id` text NOT NULL,
	`target_id` text NOT NULL,
	`connection_address` text NOT NULL,
	`requested_hostname` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`engagement_id`) REFERENCES `engagements`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_id`) REFERENCES `stone_targets`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "stone_hostname_contract_version" CHECK("stone_hostname_associations"."contract_version" = 1),
	CONSTRAINT "stone_hostname_connection_length" CHECK(length("stone_hostname_associations"."connection_address") between 1 and 512),
	CONSTRAINT "stone_hostname_requested_length" CHECK(length("stone_hostname_associations"."requested_hostname") between 1 and 253),
	CONSTRAINT "stone_hostname_status" CHECK("stone_hostname_associations"."status" in ('proposed', 'associated', 'declined')),
	CONSTRAINT "stone_hostname_created_at" CHECK(length("stone_hostname_associations"."created_at") >= 20),
	CONSTRAINT "stone_hostname_decided_at" CHECK(("stone_hostname_associations"."status" = 'proposed' and "stone_hostname_associations"."decided_at" is null) or ("stone_hostname_associations"."status" in ('associated', 'declined') and "stone_hostname_associations"."decided_at" is not null))
);
--> statement-breakpoint
CREATE INDEX `stone_hostname_target_created_idx` ON `stone_hostname_associations` (`target_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `stone_captures` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_version` integer NOT NULL,
	`engagement_id` text NOT NULL,
	`target_id` text,
	`lead_id` text,
	`kind` text NOT NULL,
	`origin_label` text NOT NULL,
	`title` text NOT NULL,
	`command` text,
	`observation` text,
	`content_digest` text NOT NULL,
	`provenance_existing_id` text,
	`byte_size` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`engagement_id`) REFERENCES `engagements`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_id`) REFERENCES `stone_targets`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "stone_capture_contract_version" CHECK("stone_captures"."contract_version" = 1),
	CONSTRAINT "stone_capture_kind" CHECK("stone_captures"."kind" in ('pasted_terminal', 'dropped_file', 'screenshot', 'nmap_xml', 'ffuf_json')),
	CONSTRAINT "stone_capture_origin" CHECK("stone_captures"."origin_label" in ('pasted', 'imported') and (("stone_captures"."kind" in ('pasted_terminal', 'dropped_file', 'screenshot') and "stone_captures"."origin_label" = 'pasted') or ("stone_captures"."kind" in ('nmap_xml', 'ffuf_json') and "stone_captures"."origin_label" = 'imported'))),
	CONSTRAINT "stone_capture_title_length" CHECK(length("stone_captures"."title") between 1 and 120 and "stone_captures"."title" = trim("stone_captures"."title")),
	CONSTRAINT "stone_capture_command_length" CHECK("stone_captures"."command" is null or length("stone_captures"."command") between 1 and 2048),
	CONSTRAINT "stone_capture_observation_single_line" CHECK("stone_captures"."observation" is null or (length("stone_captures"."observation") between 1 and 2048 and instr("stone_captures"."observation", char(10)) = 0 and instr("stone_captures"."observation", char(13)) = 0)),
	CONSTRAINT "stone_capture_digest" CHECK(length("stone_captures"."content_digest") = 71 and "stone_captures"."content_digest" glob 'sha256:[0-9a-f]*' and "stone_captures"."content_digest" not glob 'sha256:*[^0-9a-f]*'),
	CONSTRAINT "stone_capture_byte_size" CHECK("stone_captures"."byte_size" >= 0),
	CONSTRAINT "stone_capture_created_at" CHECK(length("stone_captures"."created_at") >= 20)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stone_capture_engagement_digest_unique` ON `stone_captures` (`engagement_id`,`content_digest`);
--> statement-breakpoint
CREATE INDEX `stone_capture_engagement_created_idx` ON `stone_captures` (`engagement_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `stone_capture_target_created_idx` ON `stone_captures` (`target_id`,`created_at`);

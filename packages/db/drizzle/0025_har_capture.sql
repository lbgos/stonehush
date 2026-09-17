PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stone_captures` (
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
	`content_text` text,
	`file_name` text,
	`content_digest` text NOT NULL,
	`provenance_existing_id` text,
	`byte_size` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`engagement_id`) REFERENCES `engagements`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_id`) REFERENCES `stone_targets`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "stone_capture_contract_version" CHECK("__new_stone_captures"."contract_version" = 1),
	CONSTRAINT "stone_capture_kind" CHECK("__new_stone_captures"."kind" in ('pasted_terminal', 'dropped_file', 'screenshot', 'nmap_xml', 'ffuf_json', 'har')),
	CONSTRAINT "stone_capture_origin" CHECK("__new_stone_captures"."origin_label" in ('pasted', 'imported') and (("__new_stone_captures"."kind" in ('pasted_terminal', 'dropped_file', 'screenshot') and "__new_stone_captures"."origin_label" = 'pasted') or ("__new_stone_captures"."kind" in ('nmap_xml', 'ffuf_json', 'har') and "__new_stone_captures"."origin_label" = 'imported'))),
	CONSTRAINT "stone_capture_title_length" CHECK(length("__new_stone_captures"."title") between 1 and 120 and "__new_stone_captures"."title" = trim("__new_stone_captures"."title")),
	CONSTRAINT "stone_capture_command_length" CHECK("__new_stone_captures"."command" is null or length("__new_stone_captures"."command") between 1 and 2048),
	CONSTRAINT "stone_capture_observation_single_line" CHECK("__new_stone_captures"."observation" is null or (length("__new_stone_captures"."observation") between 1 and 2048 and instr("__new_stone_captures"."observation", char(10)) = 0 and instr("__new_stone_captures"."observation", char(13)) = 0)),
	CONSTRAINT "stone_capture_file_name_length" CHECK("__new_stone_captures"."file_name" is null or length("__new_stone_captures"."file_name") between 1 and 255),
	CONSTRAINT "stone_capture_digest" CHECK(length("__new_stone_captures"."content_digest") = 71 and "__new_stone_captures"."content_digest" glob 'sha256:[0-9a-f]*' and "__new_stone_captures"."content_digest" not glob 'sha256:*[^0-9a-f]*'),
	CONSTRAINT "stone_capture_byte_size" CHECK("__new_stone_captures"."byte_size" >= 0),
	CONSTRAINT "stone_capture_created_at" CHECK(length("__new_stone_captures"."created_at") >= 20)
);
--> statement-breakpoint
INSERT INTO `__new_stone_captures`("id", "contract_version", "engagement_id", "target_id", "lead_id", "kind", "origin_label", "title", "command", "observation", "content_text", "file_name", "content_digest", "provenance_existing_id", "byte_size", "created_at") SELECT "id", "contract_version", "engagement_id", "target_id", "lead_id", "kind", "origin_label", "title", "command", "observation", "content_text", "file_name", "content_digest", "provenance_existing_id", "byte_size", "created_at" FROM `stone_captures`;--> statement-breakpoint
DROP TABLE `stone_captures`;--> statement-breakpoint
ALTER TABLE `__new_stone_captures` RENAME TO `stone_captures`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `stone_capture_engagement_digest_unique` ON `stone_captures` (`engagement_id`,`content_digest`);--> statement-breakpoint
CREATE INDEX `stone_capture_engagement_created_idx` ON `stone_captures` (`engagement_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `stone_capture_target_created_idx` ON `stone_captures` (`target_id`,`created_at`);
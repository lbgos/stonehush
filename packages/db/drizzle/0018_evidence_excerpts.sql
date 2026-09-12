CREATE TABLE `evidence_excerpts` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_version` integer NOT NULL,
	`engagement_id` text NOT NULL,
	`run_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`artifact_digest` text NOT NULL,
	`stream` text NOT NULL,
	`byte_offset` integer NOT NULL,
	`byte_length` integer NOT NULL,
	`content` text NOT NULL,
	`redactions` integer NOT NULL,
	`target_note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`engagement_id`) REFERENCES `engagements`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "evidence_excerpt_contract_version" CHECK("evidence_excerpts"."contract_version" = 1),
	CONSTRAINT "evidence_excerpt_artifact_id" CHECK(length("evidence_excerpts"."artifact_id") between 1 and 127 and substr("evidence_excerpts"."artifact_id", 1, 1) glob '[a-z0-9]' and "evidence_excerpts"."artifact_id" not glob '*[^a-z0-9-]*'),
	CONSTRAINT "evidence_excerpt_artifact_digest" CHECK(length("evidence_excerpts"."artifact_digest") = 71 and "evidence_excerpts"."artifact_digest" glob 'sha256:[0-9a-f]*' and "evidence_excerpts"."artifact_digest" not glob 'sha256:*[^0-9a-f]*'),
	CONSTRAINT "evidence_excerpt_stream" CHECK("evidence_excerpts"."stream" in ('stdout', 'stderr')),
	CONSTRAINT "evidence_excerpt_range" CHECK("evidence_excerpts"."byte_offset" >= 0 and "evidence_excerpts"."byte_length" between 1 and 8192 and "evidence_excerpts"."byte_offset" + "evidence_excerpts"."byte_length" <= 1073741824),
	CONSTRAINT "evidence_excerpt_content_bytes" CHECK(length(cast("evidence_excerpts"."content" as blob)) <= 16384),
	CONSTRAINT "evidence_excerpt_redactions" CHECK("evidence_excerpts"."redactions" >= 0),
	CONSTRAINT "evidence_excerpt_target_note" CHECK("evidence_excerpts"."target_note" is null or length("evidence_excerpts"."target_note") between 1 and 120),
	CONSTRAINT "evidence_excerpt_created_at" CHECK(length("evidence_excerpts"."created_at") >= 20)
);
--> statement-breakpoint
CREATE INDEX `evidence_excerpt_engagement_created_idx` ON `evidence_excerpts` (`engagement_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `evidence_excerpt_run_idx` ON `evidence_excerpts` (`engagement_id`,`run_id`);
--> statement-breakpoint
CREATE TABLE `evidence_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_version` integer NOT NULL,
	`engagement_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`digest` text NOT NULL,
	`caption` text NOT NULL,
	`target_label` text,
	`parent_attachment_id` text,
	`crop_rect_json` text,
	`content_base64` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`engagement_id`) REFERENCES `engagements`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`parent_attachment_id`) REFERENCES `evidence_attachments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "evidence_attachment_contract_version" CHECK("evidence_attachments"."contract_version" = 1),
	CONSTRAINT "evidence_attachment_filename" CHECK(length("evidence_attachments"."filename") between 1 and 128 and "evidence_attachments"."filename" not glob '*[^a-z0-9-]*'),
	CONSTRAINT "evidence_attachment_mime" CHECK("evidence_attachments"."mime" in ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
	CONSTRAINT "evidence_attachment_size_bytes" CHECK("evidence_attachments"."size_bytes" between 1 and 2000000),
	CONSTRAINT "evidence_attachment_digest" CHECK(length("evidence_attachments"."digest") = 71 and "evidence_attachments"."digest" glob 'sha256:[0-9a-f]*' and "evidence_attachments"."digest" not glob 'sha256:*[^0-9a-f]*'),
	CONSTRAINT "evidence_attachment_caption" CHECK(length("evidence_attachments"."caption") <= 280),
	CONSTRAINT "evidence_attachment_target_label" CHECK("evidence_attachments"."target_label" is null or length("evidence_attachments"."target_label") between 1 and 120),
	CONSTRAINT "evidence_attachment_crop_json" CHECK("evidence_attachments"."crop_rect_json" is null or (json_valid("evidence_attachments"."crop_rect_json") and length(cast("evidence_attachments"."crop_rect_json" as blob)) <= 1024)),
	CONSTRAINT "evidence_attachment_content_bytes" CHECK(length(cast("evidence_attachments"."content_base64" as blob)) between 1 and 2000000),
	CONSTRAINT "evidence_attachment_created_at" CHECK(length("evidence_attachments"."created_at") >= 20)
);
--> statement-breakpoint
CREATE INDEX `evidence_attachment_engagement_created_idx` ON `evidence_attachments` (`engagement_id`,`created_at`,`id`);

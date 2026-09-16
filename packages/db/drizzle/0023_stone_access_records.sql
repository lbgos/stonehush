CREATE TABLE `access_records` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_version` integer NOT NULL,
	`engagement_id` text NOT NULL,
	`target_id` text NOT NULL,
	`account` text NOT NULL,
	`access_type` text NOT NULL,
	`source_lead_id` text NOT NULL,
	`secret_id` text,
	`context` text,
	`last_confirmed_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`engagement_id`) REFERENCES `engagements`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "access_contract_version" CHECK("access_records"."contract_version" = 1),
	CONSTRAINT "access_account_length" CHECK(length("access_records"."account") between 1 and 120 and "access_records"."account" = trim("access_records"."account")),
	CONSTRAINT "access_type" CHECK("access_records"."access_type" in ('ssh', 'web_session', 'database', 'shell', 'other')),
	CONSTRAINT "access_context_length" CHECK("access_records"."context" is null or (length("access_records"."context") between 1 and 500 and "access_records"."context" = trim("access_records"."context"))),
	CONSTRAINT "access_last_confirmed_at" CHECK(length("access_records"."last_confirmed_at") >= 20),
	CONSTRAINT "access_created_at" CHECK(length("access_records"."created_at") >= 20),
	CONSTRAINT "access_updated_at" CHECK(length("access_records"."updated_at") >= 20)
);
--> statement-breakpoint
CREATE INDEX `access_engagement_created_idx` ON `access_records` (`engagement_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `access_engagement_target_idx` ON `access_records` (`engagement_id`,`target_id`);
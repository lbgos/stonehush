CREATE TABLE `techniques` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_version` integer NOT NULL,
	`engagement_id` text NOT NULL,
	`name` text NOT NULL,
	`when_useful` text NOT NULL,
	`prerequisites_json` text NOT NULL,
	`question` text NOT NULL,
	`procedure_json` text NOT NULL,
	`meaning` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`engagement_id`) REFERENCES `engagements`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "technique_contract_version" CHECK("techniques"."contract_version" = 1),
	CONSTRAINT "technique_name_length" CHECK(length("techniques"."name") between 1 and 80 and "techniques"."name" = trim("techniques"."name")),
	CONSTRAINT "technique_when_useful_bytes" CHECK(length(cast("techniques"."when_useful" as blob)) <= 2000),
	CONSTRAINT "technique_prerequisites_json" CHECK(json_valid("techniques"."prerequisites_json") and length(cast("techniques"."prerequisites_json" as blob)) <= 8192),
	CONSTRAINT "technique_question_bytes" CHECK(length(cast("techniques"."question" as blob)) between 1 and 2000 and "techniques"."question" = trim("techniques"."question")),
	CONSTRAINT "technique_procedure_json" CHECK(json_valid("techniques"."procedure_json") and length(cast("techniques"."procedure_json" as blob)) <= 16384),
	CONSTRAINT "technique_meaning_bytes" CHECK(length(cast("techniques"."meaning" as blob)) <= 2000),
	CONSTRAINT "technique_created_at" CHECK(length("techniques"."created_at") >= 20),
	CONSTRAINT "technique_updated_at" CHECK(length("techniques"."updated_at") >= 20)
);
--> statement-breakpoint
CREATE INDEX `technique_engagement_created_idx` ON `techniques` (`engagement_id`,`created_at`,`id`);

CREATE TABLE `gitleaks_matches` (
	`scan_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`file` text NOT NULL,
	`line` integer NOT NULL,
	`fingerprint` text NOT NULL,
	PRIMARY KEY(`scan_id`, `rule_id`, `file`, `line`, `fingerprint`),
	FOREIGN KEY (`scan_id`) REFERENCES `gitleaks_scans`(`scan_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "gitleaks_match_rule_id" CHECK(length("gitleaks_matches"."rule_id") between 1 and 128),
	CONSTRAINT "gitleaks_match_file" CHECK(length("gitleaks_matches"."file") between 1 and 1024),
	CONSTRAINT "gitleaks_match_line" CHECK("gitleaks_matches"."line" >= 0),
	CONSTRAINT "gitleaks_match_fingerprint" CHECK(length("gitleaks_matches"."fingerprint") = 16 and "gitleaks_matches"."fingerprint" not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE TABLE `gitleaks_scans` (
	`scan_id` text PRIMARY KEY NOT NULL,
	`engagement_id` text NOT NULL,
	`match_count` integer NOT NULL,
	`truncated` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`engagement_id`) REFERENCES `engagements`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "gitleaks_scan_id" CHECK(length("gitleaks_scans"."scan_id") = 36),
	CONSTRAINT "gitleaks_scan_match_count" CHECK("gitleaks_scans"."match_count" >= 0),
	CONSTRAINT "gitleaks_scan_truncated_boolean" CHECK("gitleaks_scans"."truncated" in (0, 1)),
	CONSTRAINT "gitleaks_scan_created_at" CHECK(length("gitleaks_scans"."created_at") >= 20)
);

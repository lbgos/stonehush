CREATE TABLE `vhost_results` (
	`artifact_id` text NOT NULL,
	`parser_version` text NOT NULL,
	`hostname` text NOT NULL,
	`base_url` text NOT NULL,
	`status` integer NOT NULL,
	`length` integer NOT NULL,
	`words` integer NOT NULL,
	`lines` integer NOT NULL,
	`observed_at` text NOT NULL,
	PRIMARY KEY(`artifact_id`, `parser_version`, `hostname`),
	FOREIGN KEY (`artifact_id`) REFERENCES `evidence_artifacts`(`artifact_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "vhost_result_artifact_id" CHECK(length("vhost_results"."artifact_id") between 1 and 127
        and substr("vhost_results"."artifact_id",1,1) glob '[a-z0-9]'
        and "vhost_results"."artifact_id" not glob '*[^a-z0-9-]*'),
	CONSTRAINT "vhost_result_parser_version" CHECK(length("vhost_results"."parser_version") between 1 and 64
        and "vhost_results"."parser_version" not glob '*[^a-z0-9._-]*'
        and substr("vhost_results"."parser_version", 1, 1) glob '[a-z0-9]'),
	CONSTRAINT "vhost_result_hostname" CHECK(length("vhost_results"."hostname") between 1 and 2048),
	CONSTRAINT "vhost_result_base_url" CHECK(length("vhost_results"."base_url") between 1 and 2048),
	CONSTRAINT "vhost_result_status" CHECK("vhost_results"."status" between 100 and 599),
	CONSTRAINT "vhost_result_counts" CHECK("vhost_results"."length" >= 0 and "vhost_results"."words" >= 0 and "vhost_results"."lines" >= 0),
	CONSTRAINT "vhost_result_observed_at" CHECK(length("vhost_results"."observed_at") >= 20)
);

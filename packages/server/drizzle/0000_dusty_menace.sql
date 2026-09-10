CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`model` text,
	`prompt` text DEFAULT '' NOT NULL,
	`permission_mode` text DEFAULT 'supervised' NOT NULL,
	`workspace_kind` text DEFAULT 'persistent' NOT NULL,
	`workspace_config` text DEFAULT '{}' NOT NULL,
	`allowed_tools` text DEFAULT '[]' NOT NULL,
	`disallowed_tools` text DEFAULT '[]' NOT NULL,
	`mcp_servers` text DEFAULT '{}' NOT NULL,
	`inherit_machine_mcp` integer DEFAULT false NOT NULL,
	`env` text DEFAULT '{}' NOT NULL,
	`max_turns` integer,
	`cron` text,
	`cron_timezone` text,
	`webhook_secret` text,
	`webhook_mode` text DEFAULT 'token' NOT NULL,
	`webhook_events` text DEFAULT '[]' NOT NULL,
	`allow_prompt_override` integer DEFAULT false NOT NULL,
	`concurrency` text DEFAULT 'skip' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`request_id` text NOT NULL,
	`tool_use_id` text,
	`tool_name` text NOT NULL,
	`input` text NOT NULL,
	`title` text,
	`description` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `approvals_run_status_idx` ON `approvals` (`run_id`,`status`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer DEFAULT (unixepoch()) NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_run_seq_uq` ON `run_events` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`status` text NOT NULL,
	`trigger` text NOT NULL,
	`prompt` text NOT NULL,
	`title` text,
	`claude_session_id` text,
	`workspace_path` text,
	`branch` text,
	`cost_usd` integer,
	`num_turns` integer,
	`error` text,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_agent_started_idx` ON `runs` (`agent_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`ts` integer DEFAULT (unixepoch()) NOT NULL,
	`source_ip` text,
	`delivery_key` text,
	`event` text,
	`accepted` integer NOT NULL,
	`reason` text,
	`run_id` text
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_agent_ts_idx` ON `webhook_deliveries` (`agent_id`,`ts`);
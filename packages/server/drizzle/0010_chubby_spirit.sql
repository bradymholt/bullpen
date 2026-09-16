CREATE TABLE `space_secrets` (
	`space` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);

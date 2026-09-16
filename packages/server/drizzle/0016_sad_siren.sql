ALTER TABLE `agents` ADD `trigger` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
UPDATE `agents` SET `trigger` = CASE
  WHEN `poll_url` IS NOT NULL THEN 'poll'
  WHEN `cron` IS NOT NULL THEN 'schedule'
  WHEN `webhook_events` != '[]' OR `webhook_mode` NOT IN ('token', 'custom') THEN 'webhook'
  ELSE 'manual'
END;

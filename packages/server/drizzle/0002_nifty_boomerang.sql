ALTER TABLE `agents` ADD `webhook_signature_header` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `webhook_signature_prefix` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `webhook_event_header` text;
--> statement-breakpoint
UPDATE `agents` SET `webhook_mode` = 'github' WHERE `webhook_mode` = 'hmac';

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "music_rater_url" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "music_rater_api_key" text;

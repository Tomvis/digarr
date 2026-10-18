ALTER TABLE "recommendations" ADD COLUMN "recommended_recording_mbid" text;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "recommended_track_title" text;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "recommended_track_album" text;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "recommended_cover_release_mbid" text;--> statement-breakpoint
CREATE INDEX "recommendations_user_recording_idx" ON "recommendations" USING btree ("user_id","recommended_recording_mbid");
CREATE INDEX "events_at_idx" ON "events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "spend_cap_counters_updated_at_idx" ON "spend_cap_counters" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "upload_preflights_updated_at_idx" ON "upload_preflights" USING btree ("updated_at");
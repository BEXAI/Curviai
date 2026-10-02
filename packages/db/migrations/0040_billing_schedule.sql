ALTER TABLE "credit_ledger" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "pending_tier" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "pending_cadence" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "pending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "pending_schedule_id" text;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_note_length" CHECK ("credit_ledger"."note" IS NULL OR char_length("credit_ledger"."note") <= 120);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_pending_cadence" CHECK ("subscriptions"."pending_cadence" IS NULL OR "subscriptions"."pending_cadence" IN ('monthly', 'annual'));--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_pending_tier" CHECK ("subscriptions"."pending_tier" IS NULL OR "subscriptions"."pending_tier" IN ('starter', 'growth', 'pro'));--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_pending_schedule_id_length" CHECK ("subscriptions"."pending_schedule_id" IS NULL OR char_length("subscriptions"."pending_schedule_id") BETWEEN 1 AND 255);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_pending_schedule_complete" CHECK (num_nonnulls("subscriptions"."pending_tier", "subscriptions"."pending_cadence", "subscriptions"."pending_at", "subscriptions"."pending_schedule_id") IN (0, 4));
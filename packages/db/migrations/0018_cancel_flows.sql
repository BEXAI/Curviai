-- Cancel flow with save offers (docs/phases/PHASE_11.md, b2/retention).
-- One row per pass through the cancel flow on /app/billing: the reason, the
-- save offers shown and the outcome, and whether it reached Stripe. Rows are
-- written only by the web app's owner connection. Members who can manage
-- billing (owner, admin, editor) read their own workspace's rows; the client
-- role, anon and other workspaces see nothing, and no member writes.
CREATE TABLE "cancel_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid,
	"reason" text NOT NULL,
	"detail" text,
	"from_tier" text,
	"to_tier" text,
	"offers_shown" jsonb,
	"outcome" text NOT NULL,
	"stripe_applied" boolean DEFAULT false NOT NULL,
	"stripe_subscription_id" text,
	"effective_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cancel_flows" ADD CONSTRAINT "cancel_flows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cancel_flows_workspace_id_idx" ON "cancel_flows" USING btree ("workspace_id");--> statement-breakpoint

ALTER TABLE "cancel_flows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "cancel_flows_select_billing_member" ON "cancel_flows"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin','editor')));

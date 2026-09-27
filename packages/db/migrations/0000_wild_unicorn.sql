CREATE TABLE "asset_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"channel_spec_id" text NOT NULL,
	"r2_key" text NOT NULL,
	"filename" text NOT NULL,
	"bytes" integer,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"shot_type" text NOT NULL,
	"qc" jsonb,
	"approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_kits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text DEFAULT 'Default' NOT NULL,
	"colors" jsonb,
	"fonts" jsonb,
	"logo_asset_id" uuid,
	"style_preset" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_specs" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "churn_scores" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"score" integer,
	"signals" jsonb,
	"band" text,
	"computed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"source" text,
	"job_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"name" text NOT NULL,
	"props" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gallery_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"share_slug" text,
	"category" text,
	"consent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text,
	"credits_reserved" integer DEFAULT 0 NOT NULL,
	"credits_charged" integer DEFAULT 0 NOT NULL,
	"cogs_micros" bigint DEFAULT 0 NOT NULL,
	"recipe_version_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"encrypted_token" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_workspace_id_kind_pk" PRIMARY KEY("workspace_id","kind")
);
--> statement-breakpoint
CREATE TABLE "job_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"shot_id" text,
	"stage" text,
	"provider" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text,
	"profile" jsonb,
	"mode" text NOT NULL,
	"shopify_product_gid" text,
	"amazon_sku" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"stage" text NOT NULL,
	"model" text NOT NULL,
	"body" jsonb NOT NULL,
	"traffic_pct" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"code" text PRIMARY KEY NOT NULL,
	"referrer_workspace_id" uuid,
	"referred_workspace_id" uuid,
	"rewarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"slug" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"asset_id" uuid,
	"before_media_id" uuid,
	"views" integer DEFAULT 0 NOT NULL,
	"public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"r2_key" text NOT NULL,
	"kind" text,
	"width" integer,
	"height" integer,
	"sha256" text NOT NULL,
	"mask_r2_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text,
	"external_id" text,
	"tier" text,
	"status" text,
	"period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"stripe_customer_id" text,
	"shopify_shop" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset_variants" ADD CONSTRAINT "asset_variants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_variants" ADD CONSTRAINT "asset_variants_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_variants" ADD CONSTRAINT "asset_variants_channel_spec_id_channel_specs_id_fk" FOREIGN KEY ("channel_spec_id") REFERENCES "public"."channel_specs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD CONSTRAINT "brand_kits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "churn_scores" ADD CONSTRAINT "churn_scores_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_items" ADD CONSTRAINT "gallery_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_items" ADD CONSTRAINT "gallery_items_share_slug_share_links_slug_fk" FOREIGN KEY ("share_slug") REFERENCES "public"."share_links"("slug") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_recipe_version_id_recipes_id_fk" FOREIGN KEY ("recipe_version_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_steps" ADD CONSTRAINT "job_steps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_steps" ADD CONSTRAINT "job_steps_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_workspace_id_workspaces_id_fk" FOREIGN KEY ("referrer_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_workspace_id_workspaces_id_fk" FOREIGN KEY ("referred_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_before_media_id_source_media_id_fk" FOREIGN KEY ("before_media_id") REFERENCES "public"."source_media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_media" ADD CONSTRAINT "source_media_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_media" ADD CONSTRAINT "source_media_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_variants_workspace_id_idx" ON "asset_variants" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "asset_variants_asset_id_idx" ON "asset_variants" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "assets_workspace_id_idx" ON "assets" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "assets_job_id_idx" ON "assets" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "brand_kits_workspace_id_idx" ON "brand_kits" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "credit_ledger_workspace_id_idx" ON "credit_ledger" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "credit_ledger_job_id_idx" ON "credit_ledger" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "events_workspace_id_idx" ON "events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "gallery_items_workspace_id_idx" ON "gallery_items" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "generation_jobs_workspace_id_idx" ON "generation_jobs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "generation_jobs_product_id_idx" ON "generation_jobs" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "generation_jobs_status_idx" ON "generation_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "integrations_workspace_id_idx" ON "integrations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "job_steps_workspace_id_idx" ON "job_steps" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "job_steps_job_id_idx" ON "job_steps" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "members_user_id_idx" ON "members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "products_workspace_id_idx" ON "products" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipes_key_version_uq" ON "recipes" USING btree ("key","version");--> statement-breakpoint
CREATE INDEX "referrals_referrer_workspace_id_idx" ON "referrals" USING btree ("referrer_workspace_id");--> statement-breakpoint
CREATE INDEX "referrals_referred_workspace_id_idx" ON "referrals" USING btree ("referred_workspace_id");--> statement-breakpoint
CREATE INDEX "share_links_workspace_id_idx" ON "share_links" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "source_media_workspace_id_idx" ON "source_media" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "source_media_product_id_idx" ON "source_media" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "subscriptions_workspace_id_idx" ON "subscriptions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_one_active_per_workspace_uq" ON "subscriptions" USING btree ("workspace_id") WHERE status = 'active';
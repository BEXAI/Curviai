CREATE TABLE "pack_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" text,
	"filename" text NOT NULL,
	"r2_key" text NOT NULL,
	"bytes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_ledger" ALTER COLUMN "delta" SET DATA TYPE numeric(12, 1);--> statement-breakpoint
ALTER TABLE "generation_jobs" ALTER COLUMN "credits_reserved" SET DATA TYPE numeric(12, 1);--> statement-breakpoint
ALTER TABLE "generation_jobs" ALTER COLUMN "credits_charged" SET DATA TYPE numeric(12, 1);--> statement-breakpoint
ALTER TABLE "pack_files" ADD CONSTRAINT "pack_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_files" ADD CONSTRAINT "pack_files_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pack_files_workspace_id_idx" ON "pack_files" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "pack_files_job_id_idx" ON "pack_files" USING btree ("job_id");
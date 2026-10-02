import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Enumerated values are plain text columns typed at the TypeScript layer so the
// job state machine and ledger reasons can evolve without enum migrations.

export type MemberRole = "owner" | "admin" | "editor" | "client";
export type ProductMode = "listing" | "concept";
export type SourceMediaKind = "image" | "video" | "frame";
/** The role the seller gave a photo (packages/pipeline seller-inputs
 * ANGLE_ROLES; a check constraint keeps the column to these values). */
export type SourceMediaAngle = "front" | "back" | "side" | "detail" | "in_the_box" | "scale";
export type JobStatus =
  | "queued"
  | "analyzing"
  | "planning"
  | "generating"
  | "qc"
  | "packaging"
  | "done"
  | "failed"
  | "canceled";
export type LedgerReason =
  | "grant"
  | "topup"
  | "reserve"
  | "charge"
  | "release"
  | "refund"
  | "referral"
  | "expire";
/** signup: the free tier's one time grant, paid by grant_signup_credits once
 * the user's email is confirmed (migration 0012). */
export type LedgerSource = "stripe" | "shopify" | "system" | "signup";
export type SubscriptionProvider = "stripe" | "shopify";
export type IntegrationKind = "shopify" | "amazon" | "gdrive" | "dropbox" | "canva";
export type ChurnBand = "healthy" | "watch" | "at_risk";

/** One stage's recipe assignment on a job: the row it ran on (null when the
 * worker fell back to seed data) and that row's version. */
export interface JobRecipeVariant {
  recipeId: string | null;
  version: number;
  source: "db" | "seed";
}

/** A box normalized to 0..1 of the upright photo: x and y are the top left
 * corner, width and height the size, all as shares of the photo's width and
 * height (migration 0020). */
export interface SourceMediaTargetBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The seller's note parsed into structured intent by intake (0020). Same
 * shape as SellerIntent in @curvi/pipeline, kept here so the db package does
 * not depend on the pipeline. */
export interface JobSellerIntent {
  featureOnly: string | null;
  exclude: string[];
  mustKeep: string[];
  styleNotes: string | null;
}

/**
 * What the product inventory found in each photo of a job (0021,
 * docs/phases/PHASE_13.md): the significant pieces of the photo's cutout
 * with deterministic facts (box normalized to 0..1 of the upright working
 * photo, area share, shape, dominant color), the label intake gave the piece
 * when one matched, and whether the pack featured, removed or kept it.
 * Same shape as JobInventory in @curvi/pipeline.
 */
export interface JobInventoryItem {
  label: string;
  labelSource: "intake" | "deterministic";
  box: { x: number; y: number; width: number; height: number };
  areaShare: number;
  aspectRatio: number;
  shape: "tall" | "wide" | "square";
  colorHex: string;
  colorName: string;
  status: "featured" | "removed" | "kept";
}

export interface JobInventoryPhoto {
  mediaId: string;
  items: JobInventoryItem[];
  intakeCount: number | null;
  countMatch: boolean | null;
  unmatchedItems: number[];
  unmatchedProducts: string[];
  rule: string;
  touching: boolean;
  /** The vision picker's answer when the rules could not decide (rule
   * "vision" when it was taken). No migration: the column is jsonb. */
  vision?: {
    choice: number | null;
    confidence: "high" | "medium" | "low";
    reason: string;
    outcome: string;
  };
}

export interface JobInventory {
  version: 1;
  photos: JobInventoryPhoto[];
}

/** The seller's resolved output options for a job (0023,
 * docs/phases/PHASE_15.md): look, background, badge, originals and the
 * extras, with a schema version `v`. Typed structurally so the db package
 * does not depend on the pipeline; web and trigger parse it with the shared
 * ResolvedOutputOptions schema in @curvi/pipeline and fail closed when it
 * does not parse. Null reads as the defaults. */
export type JobOutputOptions = Record<string, unknown>;

/** The seller's answers to the question step (0024, docs/phases/PHASE_16.md
 * workstream 4), keyed by question id, a JSON object when set. Typed
 * structurally like JobOutputOptions so the db package keeps no pipeline
 * dependency; web and trigger parse it with the shared schema in
 * @curvi/pipeline. Null when the seller skipped the step or on jobs from
 * before 0024. */
export type JobSellerAnswers = Record<string, unknown>;
/** The worker payload a deploy saved to start a pack again (deploy_restarts,
 * PHASE_18 P18-23): the generate-pack input, a JSON object. */
export type JobRestartPayload = Record<string, unknown>;

/** A product's saved output choices (0023), as the seller picked them
 * (OutputOptionsInput in @curvi/pipeline), never the resolved hex. */
export type ProductOutputDefaults = Record<string, unknown>;

/** What the ingest check found in one uploaded photo (0023), such as its
 * size and whether it was re encoded at upload (SourceMediaIngest in
 * @curvi/pipeline). Null on rows from before 0023. */
export type SourceMediaIngest = Record<string, unknown>;

/**
 * The first run answers (docs/phases/PHASE_18.md P18-20, migration
 * seller_profile): what the workspace sells (a seeded sellerCategories key)
 * and where (seeded channelChoices values). Written only by the server;
 * the protected columns trigger refuses a client write.
 */
export interface SellerProfileRecord {
  category?: string;
  channels?: string[];
  /** ISO 8601, when the answers were saved. */
  answeredAt?: string;
}

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    plan: text("plan").notNull().default("free"),
    stripeCustomerId: text("stripe_customer_id"),
    shopifyShop: text("shopify_shop"),
    // Phase 18 seller_profile (Lane 8 Activation).
    sellerProfile: jsonb("seller_profile").$type<SellerProfileRecord>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "workspaces_seller_profile_object",
      sql`${t.sellerProfile} IS NULL OR (jsonb_typeof(${t.sellerProfile}) = 'object' AND octet_length(${t.sellerProfile}::text) <= 1024)`,
    ),
  ],
);

export const members = pgTable(
  "members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    role: text("role").$type<MemberRole>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("members_user_id_idx").on(t.userId),
  ],
);

export const brandKits = pgTable(
  "brand_kits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Default"),
    colors: jsonb("colors").$type<string[]>(),
    fonts: jsonb("fonts").$type<Record<string, string>>(),
    logoAssetId: uuid("logo_asset_id"),
    logoR2Key: text("logo_r2_key"),
    stylePreset: text("style_preset"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("brand_kits_workspace_id_idx").on(t.workspaceId)],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title"),
    profile: jsonb("profile").$type<Record<string, unknown>>(),
    mode: text("mode").$type<ProductMode>().notNull(),
    shopifyProductGid: text("shopify_product_gid"),
    amazonSku: text("amazon_sku"),
    // Seller inputs the planner uses (migration 0014): the seller's own SKU
    // for file names, what is in the box and comparison facts, one printable
    // line each, as typed. The in_the_box and comparison shots print these.
    sku: text("sku"),
    boxContents: jsonb("box_contents").$type<string[]>(),
    comparisonFacts: jsonb("comparison_facts").$type<string[]>(),
    // Press quotes or awards the seller typed for the A+ endorsement module
    // (migration 0025, PHASE_16 workstream 2), one printable line each, as
    // typed. Null or empty means the module is skipped; a model never
    // writes one.
    endorsements: jsonb("endorsements").$type<string[]>(),
    // The seller's saved output choices for this product (0023), a JSON
    // object when set. Null means the defaults.
    outputDefaults: jsonb("output_defaults").$type<ProductOutputDefaults>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("products_workspace_id_idx").on(t.workspaceId),
    check(
      "products_output_defaults_object",
      sql`${t.outputDefaults} IS NULL OR jsonb_typeof(${t.outputDefaults}) = 'object'`,
    ),
    check("products_endorsements_array", sql`${t.endorsements} IS NULL OR jsonb_typeof(${t.endorsements}) = 'array'`),
  ],
);

export const sourceMedia = pgTable(
  "source_media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    r2Key: text("r2_key").notNull(),
    kind: text("kind").$type<SourceMediaKind>(),
    width: integer("width"),
    height: integer("height"),
    sha256: text("sha256").notNull(),
    maskR2Key: text("mask_r2_key"),
    /** Which angle the photo shows, when the seller said (migration 0014). */
    angle: text("angle").$type<SourceMediaAngle>(),
    /** The product in this photo the pack is for, as a box normalized to
     * 0..1 of the upright photo (migration 0020). Written by the product
     * chooser; null when the seller did not choose. */
    targetBox: jsonb("target_box").$type<SourceMediaTargetBox>(),
    /** What the ingest check found in this photo (migration 0023), a JSON
     * object when set; null on rows from before 0023. */
    ingest: jsonb("ingest").$type<SourceMediaIngest>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "source_media_angle_check",
      sql`${t.angle} is null or ${t.angle} in ('front', 'back', 'side', 'detail', 'in_the_box', 'scale')`,
    ),
    check("source_media_ingest_object", sql`${t.ingest} IS NULL OR jsonb_typeof(${t.ingest}) = 'object'`),
    index("source_media_workspace_id_idx").on(t.workspaceId),
    index("source_media_product_id_idx").on(t.productId),
    // One row per uploaded object (Update.md 6.3): a retried pack submit
    // inserts with ON CONFLICT DO NOTHING instead of duplicating the photo.
    uniqueIndex("source_media_workspace_r2_key_uq").on(t.workspaceId, t.r2Key),
    // The 30 day source purge (migration 0015) scans by age.
    index("source_media_created_at_idx").on(t.createdAt),
  ],
);

export const recipes = pgTable(
  "recipes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    version: integer("version").notNull(),
    stage: text("stage").notNull(),
    model: text("model").notNull(),
    // Models tried in order after model fails; the worker routes the whole
    // list through @curvi/ai failover, so a swap is a row update (0017).
    fallbackModels: jsonb("fallback_models").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
    // A/B weight among the active versions of one key.
    trafficPct: integer("traffic_pct").notNull().default(100),
    active: boolean("active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("recipes_key_version_uq").on(t.key, t.version)],
);

export const generationJobs = pgTable(
  "generation_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    // Unique per workspace (0019): two workspaces sending the same key never
    // collide, so a conflict never reveals another workspace's job.
    idempotencyKey: text("idempotency_key"),
    // The requested channels and mode, so idempotency replays can verify the
    // body matches and the progress board can show real channels.
    channels: jsonb("channels").$type<string[]>(),
    mode: text("mode").$type<ProductMode>(),
    // numeric(12,1): the plan prices deterministic assets at 0.5 credit, so
    // integer columns cannot hold real reservations and charges.
    creditsReserved: numeric("credits_reserved", { precision: 12, scale: 1, mode: "number" })
      .notNull()
      .default(0),
    creditsCharged: numeric("credits_charged", { precision: 12, scale: 1, mode: "number" })
      .notNull()
      .default(0),
    cogsMicros: bigint("cogs_micros", { mode: "number" }).notNull().default(0),
    recipeVersionId: uuid("recipe_version_id").references(() => recipes.id),
    // The recipe version each stage ran on, keyed by recipe key, so A/B
    // results can be read per job (0017).
    recipeVariants: jsonb("recipe_variants").$type<Record<string, JobRecipeVariant>>(),
    // The run that owns the job right now (0019). The web app sets a fresh
    // key in the same transaction that queues a run (a first run or a
    // follow up) and the runner passes it back on every liveness check, so a
    // stale runner of an earlier run is refused even after a follow up moved
    // the job from done back to generating. A cancel or settle changes it.
    // Null on rows from before 0019: those runs are checked by status alone.
    runKey: text("run_key"),
    // The seller's note exactly as typed, and the structured intent intake
    // parsed from it (0020), so follow ups and retries keep what the seller
    // asked for. Both null on jobs without a note or from before 0020.
    sellerNote: text("seller_note"),
    sellerIntent: jsonb("seller_intent").$type<JobSellerIntent>(),
    // What the product inventory found in each photo and which piece the
    // pack featured (0021). Null on jobs that ran no inventory (demo mode,
    // or from before 0021).
    inventory: jsonb("inventory").$type<JobInventory>(),
    // The seller's resolved output options (0023), a JSON object when set.
    // Null on jobs from before 0023 and reads as the defaults, so every
    // older pack reads as Marketplace ready.
    outputOptions: jsonb("output_options").$type<JobOutputOptions>(),
    // The seller's answers to the question step (0024), a JSON object when
    // set. Null when the step was skipped or on jobs from before 0024.
    sellerAnswers: jsonb("seller_answers").$type<JobSellerAnswers>(),
    // Deploy restarts (migration deploy_restarts, PHASE_18 P18-23). How many
    // times a deploy queued this pack to start again (capped by the seed's
    // deployRestarts.max), and, while a restart waits to be picked up, the
    // worker payload it starts from (cleared when a runner claims it). Only
    // the server writes either: a trigger refuses client connections.
    restartCount: integer("restart_count").notNull().default(0),
    restartPayload: jsonb("restart_payload").$type<JobRestartPayload>(),
    /** Server owned runner lease and timing metadata (PHASE_20 P20-32/35).
     * Null for old rows until a runner claims them. The existing restart
     * payload stores the durable recovery input, so no duplicate is added. */
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    runnerId: text("runner_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("generation_jobs_workspace_id_idx").on(t.workspaceId),
    index("generation_jobs_product_id_idx").on(t.productId),
    index("generation_jobs_status_idx").on(t.status),
    // The scheduled stale job sweep reads live jobs by status and age (0017).
    index("generation_jobs_status_updated_at_idx").on(t.status, t.updatedAt),
    index("generation_jobs_live_heartbeat_idx")
      .on(t.status, t.heartbeatAt)
      .where(sql`${t.status} IN ('queued', 'analyzing', 'planning', 'generating', 'qc', 'packaging')`),
    uniqueIndex("generation_jobs_workspace_idempotency_key_uq").on(t.workspaceId, t.idempotencyKey),
    check(
      "generation_jobs_output_options_object",
      sql`${t.outputOptions} IS NULL OR jsonb_typeof(${t.outputOptions}) = 'object'`,
    ),
    check(
      "generation_jobs_seller_answers_object",
      sql`${t.sellerAnswers} IS NULL OR jsonb_typeof(${t.sellerAnswers}) = 'object'`,
    ),
    check(
      "generation_jobs_restart_payload_object",
      sql`${t.restartPayload} IS NULL OR jsonb_typeof(${t.restartPayload}) = 'object'`,
    ),
    check("generation_jobs_restart_count_range", sql`${t.restartCount} >= 0`),
    check("generation_jobs_runner_id_length", sql`${t.runnerId} IS NULL OR char_length(${t.runnerId}) <= 64`),
  ],
);

export const jobSteps = pgTable(
  "job_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => generationJobs.id, { onDelete: "cascade" }),
    shotId: text("shot_id"),
    stage: text("stage"),
    provider: text("provider"),
    attempt: integer("attempt").notNull().default(1),
    status: text("status"),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("job_steps_workspace_id_idx").on(t.workspaceId),
    index("job_steps_job_id_idx").on(t.jobId),
  ],
);

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => generationJobs.id, { onDelete: "cascade" }),
    shotType: text("shot_type").notNull(),
    qc: jsonb("qc").$type<Record<string, unknown>>(),
    approved: boolean("approved").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("assets_workspace_id_idx").on(t.workspaceId),
    index("assets_job_id_idx").on(t.jobId),
    // Target of the favorites (asset_id, workspace_id) foreign key (0024).
    uniqueIndex("assets_id_workspace_id_uq").on(t.id, t.workspaceId),
  ],
);

export const channelSpecs = pgTable("channel_specs", {
  id: text("id").primaryKey(),
  version: integer("version").notNull(),
  spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Shared running totals for provider spend caps (plan 4.4): one row per
 * cap key (per asset, per pack, per day). Platform table, not tenant data:
 * RLS is on with no policies, so only the worker's owner connection reads
 * or writes it. Every Trigger.dev run and web instance shares these totals,
 * which an in process counter cannot do. */
export const spendCapCounters = pgTable("spend_cap_counters", {
  key: text("key").primaryKey(),
  totalMicros: bigint("total_micros", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("spend_cap_counters_updated_at_idx").on(t.updatedAt)]);

/** Platform tunables the database reads directly, such as the free signup
 * grant (free_signup_credits), seeded from packages/pipeline seed data by
 * pnpm db:seed (CLAUDE.md rule 2). Platform table: RLS on with no policies
 * and no client privileges, like spend_cap_counters. */
export const platformSettings = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per user once their free signup grant is settled, so the grant
 * lands exactly once per user even if a workspace is deleted and provisioned
 * again. email_key is a sha256 of the normalized email (lower case, plus tag
 * removed, Gmail dots removed): at most one paid grant per key, so plus
 * addressing cannot farm free credits. A withheld grant keeps credits 0 and
 * says why. Platform table: RLS on with no policies and no client privileges;
 * only the SECURITY DEFINER grant functions write it. */
export const signupGrants = pgTable(
  "signup_grants",
  {
    userId: uuid("user_id").primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    emailKey: text("email_key"),
    credits: numeric("credits", { precision: 12, scale: 1, mode: "number" }).notNull().default(0),
    withheldReason: text("withheld_reason"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("signup_grants_workspace_id_idx").on(t.workspaceId),
    uniqueIndex("signup_grants_paid_email_key_uq")
      .on(t.emailKey)
      .where(sql`credits > 0 and email_key is not null`),
  ],
);

export const assetVariants = pgTable(
  "asset_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    channelSpecId: text("channel_spec_id")
      .notNull()
      .references(() => channelSpecs.id),
    r2Key: text("r2_key").notNull(),
    filename: text("filename").notNull(),
    bytes: integer("bytes"),
    width: integer("width"),
    height: integer("height"),
    // Whether this variant ships (0024, docs/phases/PHASE_16.md workstream
    // 6). Scene variations the seller did not pick are stored with false and
    // the packager leaves them out. Every existing row reads true.
    picked: boolean("picked").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("asset_variants_workspace_id_idx").on(t.workspaceId),
    index("asset_variants_asset_id_idx").on(t.assetId),
  ],
);

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    delta: numeric("delta", { precision: 12, scale: 1, mode: "number" }).notNull(),
    reason: text("reason").$type<LedgerReason>().notNull(),
    source: text("source").$type<LedgerSource>(),
    jobId: uuid("job_id").references(() => generationJobs.id),
    // Idempotency key for charges: at most one charge row per (job, step).
    stepKey: text("step_key"),
    // Unused: credits never expire (PHASE_20 P20-05), no grant writes it and
    // migration billing_terms cleared the old top up values.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Server supplied label for the billing history (PHASE_20 P20-09). */
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("credit_ledger_workspace_id_idx").on(t.workspaceId),
    index("credit_ledger_job_id_idx").on(t.jobId),
    check("credit_ledger_note_length", sql`${t.note} IS NULL OR char_length(${t.note}) <= 120`),
    uniqueIndex("credit_ledger_job_step_charge_uq")
      .on(t.jobId, t.stepKey)
      .where(sql`reason = 'charge' and step_key is not null`),
  ],
);

export type PackFileKind = "zip" | "report";

// Delivered pack outputs: one row per channel zip and one for the compliance
// report, uploaded to R2 by the worker's job store. Individual image files get
// asset_variants rows; this table holds the pack level artifacts.
export const packFiles = pgTable(
  "pack_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => generationJobs.id, { onDelete: "cascade" }),
    kind: text("kind").$type<PackFileKind>().notNull(),
    channel: text("channel"),
    filename: text("filename").notNull(),
    r2Key: text("r2_key").notNull(),
    bytes: integer("bytes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("pack_files_workspace_id_idx").on(t.workspaceId),
    index("pack_files_job_id_idx").on(t.jobId),
  ],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").$type<SubscriptionProvider>(),
    externalId: text("external_id"),
    tier: text("tier"),
    status: text("status"),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    // True once the subscription is set to end at periodEnd instead of
    // renewing (Stripe cancel_at_period_end), 0019.
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    /** "monthly" or "annual", from the price's interval on every
     * subscription event (PHASE_20 P20-07, migration billing_terms), so the
     * renewal notices select on it. Null until the next event for rows
     * written before it. */
    cadence: text("cadence").$type<"monthly" | "annual">(),
    /** A plan change scheduled for the next renewal (PHASE_20 P20-06). */
    pendingTier: text("pending_tier"),
    pendingCadence: text("pending_cadence").$type<"monthly" | "annual">(),
    pendingAt: timestamp("pending_at", { withTimezone: true }),
    pendingScheduleId: text("pending_schedule_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("subscriptions_workspace_id_idx").on(t.workspaceId),
    check("subscriptions_pending_cadence", sql`${t.pendingCadence} IS NULL OR ${t.pendingCadence} IN ('monthly', 'annual')`),
    check("subscriptions_pending_tier", sql`${t.pendingTier} IS NULL OR ${t.pendingTier} IN ('starter', 'growth', 'pro')`),
    check("subscriptions_pending_schedule_id_length", sql`${t.pendingScheduleId} IS NULL OR char_length(${t.pendingScheduleId}) BETWEEN 1 AND 255`),
    check("subscriptions_pending_schedule_complete", sql`num_nonnulls(${t.pendingTier}, ${t.pendingCadence}, ${t.pendingAt}, ${t.pendingScheduleId}) IN (0, 4)`),
    // One active subscription per workspace.
    uniqueIndex("subscriptions_one_active_per_workspace_uq")
      .on(t.workspaceId)
      .where(sql`status = 'active'`),
  ],
);

/** pending: signed up from an invite link; qualified: the referred
 * workspace's first payment arrived; rewarded: both sides got their
 * credits; rejected: no reward (reject_reason says why); reversed: rewarded,
 * then a refund or dispute of that payment took the rewards back. */
export type ReferralStatus = "pending" | "qualified" | "rewarded" | "rejected" | "reversed";

/** One referred workspace per row (docs/phases/PHASE_18.md P18-24,
 * migration referrals): the invite code that brought it, whose code that
 * is, and how far the reward went. qualifying_payment is the billing grant
 * key (invoice:<id> or checkout:<id>) of the payment that qualified it,
 * which a refund or dispute of that payment matches. Members of the
 * referrer read their rows (0011); only the server writes. */
export const referrals = pgTable(
  "referrals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").references(() => referralCodes.code, { onDelete: "set null" }),
    referrerWorkspaceId: uuid("referrer_workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    referredWorkspaceId: uuid("referred_workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    status: text("status").$type<ReferralStatus>().notNull().default("pending"),
    rejectReason: text("reject_reason"),
    qualifyingPayment: text("qualifying_payment"),
    qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
    rewardedAt: timestamp("rewarded_at", { withTimezone: true }),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("referrals_referrer_workspace_id_idx").on(t.referrerWorkspaceId),
    uniqueIndex("referrals_referred_workspace_id_uq").on(t.referredWorkspaceId),
    index("referrals_qualifying_payment_idx").on(t.qualifyingPayment),
    check(
      "referrals_status_check",
      sql`${t.status} in ('pending', 'qualified', 'rewarded', 'rejected', 'reversed')`,
    ),
    check(
      "referrals_reject_reason_check",
      sql`(${t.status} in ('rejected', 'reversed')) = (${t.rejectReason} is not null) and char_length(coalesce(${t.rejectReason}, '')) <= 40`,
    ),
    check(
      "referrals_qualifying_payment_check",
      sql`${t.qualifyingPayment} is null or ${t.qualifyingPayment} ~ '^(invoice|checkout):[A-Za-z0-9_]{1,200}$'`,
    ),
  ],
);

export type ShareKind = "before_after" | "pack";

/** A pack's public share page at /s/{slug} (plan 9.6.1). One row per job:
 * publishing again reuses the slug, and unpublishing only clears the public
 * flag, so a link someone already posted comes back when the owner
 * republishes. Only the server's owner connection writes rows (0011), and
 * the public page reads through the server too, which is why 0016 removed
 * the anonymous read policy. */
export const shareLinks = pgTable(
  "share_links",
  {
    slug: text("slug").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => generationJobs.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ShareKind>().notNull().default("before_after"),
    title: text("title"),
    // The hero after image.
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    beforeMediaId: uuid("before_media_id").references(() => sourceMedia.id, {
      onDelete: "set null",
    }),
    views: integer("views").notNull().default(0),
    isPublic: boolean("public").notNull().default(false),
    // The opt in proof panel (migration share_proof, docs/phases/PHASE_18.md
    // P18-16): the public page shows each image's measured checks. Off for
    // seller shares until the owner turns it on (founder decision 9).
    showProof: boolean("show_proof").notNull().default(false),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("share_links_workspace_id_idx").on(t.workspaceId),
    uniqueIndex("share_links_job_id_uq").on(t.jobId).where(sql`job_id is not null`),
  ],
);

export const galleryItems = pgTable(
  "gallery_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    shareSlug: text("share_slug").references(() => shareLinks.slug, { onDelete: "set null" }),
    category: text("category"),
    // Anonymous visitors only ever see rows explicitly published to the gallery.
    published: boolean("published").notNull().default(false),
    reviewStatus: text("review_status").$type<"pending" | "approved" | "rejected">().notNull().default("pending"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),
    consentAt: timestamp("consent_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("gallery_items_workspace_id_idx").on(t.workspaceId),
    check("gallery_items_review_status", sql`${t.reviewStatus} IN ('pending', 'approved', 'rejected')`),
    // One gallery entry per share page, so opting in twice never lists a
    // makeover twice.
    uniqueIndex("gallery_items_share_slug_uq").on(t.shareSlug).where(sql`share_slug is not null`),
  ],
);

/** Emails left on the free tools (plan 9.7, the checker as lead magnet).
 * Anonymous visitors, not tenant data, so there is no workspace_id: a
 * platform table with RLS on, no policies and no client privileges, like
 * signup_grants. Only the server's owner connection (POST /api/leads)
 * writes it. One row per normalized email; a repeat visit bumps hits and
 * last_seen_at. */
export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    /** The tool or page that captured the email first, e.g. "main-image-checker". */
    source: text("source").notNull(),
    /** The most recent tool or page the email was left on. */
    lastSource: text("last_source"),
    hits: integer("hits").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    // Phase 18 lifecycle_email (Lane 3 Email): when the visitor ticked "Also
    // send me tips on listing images and the occasional offer", and on which
    // tool. Null for every lead captured before that box shipped, so they
    // never get marketing email (PHASE_18 founder decision 5).
    marketingConsentAt: timestamp("marketing_consent_at", { withTimezone: true }),
    consentSource: text("consent_source"),
  },
  (t) => [
    uniqueIndex("leads_email_uq").on(t.email),
    check(
      "leads_consent_check",
      sql`(${t.marketingConsentAt} is null) = (${t.consentSource} is null) and char_length(coalesce(${t.consentSource}, '')) <= 40`,
    ),
  ],
);

export const integrations = pgTable(
  "integrations",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").$type<IntegrationKind>().notNull(),
    encryptedToken: text("encrypted_token"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.kind] }),
    index("integrations_workspace_id_idx").on(t.workspaceId),
  ],
);

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    props: jsonb("props").$type<Record<string, unknown>>(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("events_workspace_id_idx").on(t.workspaceId), index("events_at_idx").on(t.at)],
);

/** Why a subscriber opened the cancel flow (Stripe's cancellation feedback values). */
export type CancelReason =
  | "too_expensive"
  | "unused"
  | "missing_features"
  | "low_quality"
  | "switched_service"
  | "too_complex"
  | "customer_service"
  | "other";
/** What the cancel flow ended in: a save offer taken, a cancellation, or keeping the plan. */
export type CancelOutcome = "paused" | "downgraded" | "discounted" | "canceled" | "kept";

/**
 * One pass through the cancel flow on /app/billing: the reason, the save
 * offers shown, and the outcome. stripe_applied says whether the outcome
 * reached Stripe (false while card payments are not open, or when Stripe
 * refused it, with error set). Written by the owner connection only.
 */
export const cancelFlows = pgTable(
  "cancel_flows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id"),
    // Optional since PHASE_20 P20-07 (Minnesota asks only for what is
    // needed to cancel): null when the subscriber gave no reason.
    reason: text("reason").$type<CancelReason>(),
    detail: text("detail"),
    fromTier: text("from_tier"),
    toTier: text("to_tier"),
    offersShown: jsonb("offers_shown").$type<string[]>(),
    outcome: text("outcome").$type<CancelOutcome>().notNull(),
    stripeApplied: boolean("stripe_applied").notNull().default(false),
    stripeSubscriptionId: text("stripe_subscription_id"),
    /** When a pause ends or a cancellation takes effect. */
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    /** A subscription schedule (a downgrade the founder set up in the
     * Dashboard) released before this choice was applied, so the founder
     * can see which scheduled downgrade it undid (PHASE_20 P20-06). */
    releasedScheduleId: text("released_schedule_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cancel_flows_workspace_id_idx").on(t.workspaceId)],
);

export const churnScores = pgTable("churn_scores", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  score: integer("score"),
  signals: jsonb("signals").$type<Record<string, unknown>>(),
  band: text("band").$type<ChurnBand>(),
  computedAt: timestamp("computed_at", { withTimezone: true }),
});

/** How a terms acceptance reached the server: the signup confirmation link
 * (auth callback), the first signed in visit to /app, or the first visit to
 * the ChatGPT consent page (PHASE_19 P19-09), for an account that has no
 * record yet. */
export type TermsAcceptanceSource = "signup_callback" | "first_app_visit" | "assistant_consent";

/**
 * Server side record that a user accepted a version of the terms of service
 * (migration 0015). Written only by the web app's owner connection, with the
 * server's clock and the request's IP, so it replaces trusting the
 * terms_accepted_at value the browser puts in editable user metadata. One row
 * per user and version. Members read their own rows; nobody writes through
 * the anon or authenticated roles.
 */
export const termsAcceptances = pgTable(
  "terms_acceptances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    version: text("version").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    source: text("source").$type<TermsAcceptanceSource>().notNull(),
  },
  (t) => [
    uniqueIndex("terms_acceptances_user_version_uq").on(t.userId, t.version),
    index("terms_acceptances_workspace_id_idx").on(t.workspaceId),
  ],
);

/** A preflight's status: ready to pack, a product to choose, a problem that
 * stops the pack, or a check that could not run. */
export type UploadPreflightStatus = "ready" | "choose" | "blocked" | "unavailable";

/**
 * The preflight of one uploaded photo (migration 0022, docs/phases/
 * PHASE_14.md workstream 4): what intake, moderation, the product inventory
 * and the size gate said about it before any pack was started, cached per
 * upload key so the form can show it again and the pack can reuse the
 * intake answer instead of paying for it twice. note_key is a sha256 of the
 * seller's note the intake answer was given for; result is the seller facing
 * verdict (thumbnail object keys, never signed urls); intake is the per
 * photo intake answer and its recipe version; cost_micros is the provider
 * spend of every preflight of this photo, booked on the workspace and never
 * charged in credits. Tenant table: members read, only the owner connection
 * writes (the 0011 pattern).
 */
export const uploadPreflights = pgTable(
  "upload_preflights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    r2Key: text("r2_key").notNull(),
    noteKey: text("note_key").notNull(),
    status: text("status").$type<UploadPreflightStatus>().notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    intake: jsonb("intake").$type<Record<string, unknown>>(),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("upload_preflights_status_check", sql`${t.status} in ('ready', 'choose', 'blocked', 'unavailable')`),
    uniqueIndex("upload_preflights_workspace_r2_key_uq").on(t.workspaceId, t.r2Key),
    index("upload_preflights_workspace_id_idx").on(t.workspaceId),
    index("upload_preflights_updated_at_idx").on(t.updatedAt),
  ],
);

/**
 * Workspace API keys (migration 0024, docs/phases/PHASE_16.md workstream 5)
 * for the public API v1, the hosted MCP server and the CLI. The key itself is
 * shown once and never stored: key_hash is its hash and prefix the unique
 * public start of the key the server looks the row up by. scopes lists what
 * the key may do; a key with revoked_at set no longer works (keys are
 * revoked, never deleted). created_by is the auth user who made it. Tenant
 * table: only owners and admins read, insert or update rows; no delete
 * policy.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("api_keys_prefix_uq").on(t.prefix),
    index("api_keys_workspace_id_idx").on(t.workspaceId),
  ],
);

/**
 * Favorite assets for the gallery and /app/library (migration 0024,
 * docs/phases/PHASE_16.md workstream 6): at most one row per workspace and
 * asset. Tenant table: members read; owners, admins and editors add and
 * remove favorites, and only for an asset of their own workspace.
 */
export const favorites = pgTable(
  "favorites",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The primary key is the unique (workspace_id, asset_id) pair.
    primaryKey({ columns: [t.workspaceId, t.assetId] }),
    // The asset must belong to the same workspace, whoever writes the row
    // (the owner connection bypasses RLS), so the foreign key takes both.
    foreignKey({
      name: "favorites_asset_workspace_fk",
      columns: [t.assetId, t.workspaceId],
      foreignColumns: [assets.id, assets.workspaceId],
    }).onDelete("cascade"),
    index("favorites_asset_id_idx").on(t.assetId),
  ],
);

/** The class of browser a page view came from, read from its user agent. */
export type VisitDevice = "mobile" | "tablet" | "desktop";

/**
 * The cookieless visitor count's daily salt (migration 0027): 32 random bytes
 * as 64 hex characters, one row per UTC day, made by the first page view of
 * that day. The web app deletes salts older than yesterday, so once a salt
 * is gone nobody can recompute a visitor_hash of that day or link it to the
 * same person on another day. Platform table: RLS on with no policies and no
 * client privileges; only the owner connection reads or writes it.
 */
export const siteVisitSalts = pgTable(
  "site_visit_salts",
  {
    day: date("day", { mode: "string" }).primaryKey(),
    salt: text("salt").notNull(),
  },
  (t) => [check("site_visit_salts_salt_check", sql`${t.salt} ~ '^[0-9a-f]{64}$'`)],
);

/**
 * One page view of the public site (migration 0027, apps/web/src/lib/visits).
 * visitor_hash is the first 16 bytes (hex) of HMAC-SHA256 under the
 * server's VISITS_HASH_KEY over (daily salt, site host, client IP, user
 * agent), so it is the same for one browser all day and means nothing once
 * the day's salt is deleted. Neither the IP nor the user
 * agent is stored anywhere. path is normalized (no query string, ids as
 * :id), referrer_host is a host name only and is set only on the first page
 * view after a full page load. No time of day is kept, only the UTC day, so
 * rows cannot be lined up by time with other records. Platform table: RLS on
 * with no policies and no client privileges; only the owner connection
 * reads or writes it.
 */
export const siteVisits = pgTable(
  "site_visits",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    day: date("day", { mode: "string" }).notNull(),
    visitorHash: text("visitor_hash").notNull(),
    path: text("path").notNull(),
    referrerHost: text("referrer_host"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    device: text("device").$type<VisitDevice>().notNull(),
  },
  (t) => [
    check("site_visits_visitor_hash_check", sql`${t.visitorHash} ~ '^[0-9a-f]{32}$'`),
    check("site_visits_device_check", sql`${t.device} in ('mobile', 'tablet', 'desktop')`),
    check(
      "site_visits_lengths_check",
      sql`char_length(${t.path}) <= 300 and char_length(coalesce(${t.referrerHost}, '')) <= 255 and char_length(coalesce(${t.utmSource}, '')) <= 100 and char_length(coalesce(${t.utmMedium}, '')) <= 100 and char_length(coalesce(${t.utmCampaign}, '')) <= 100`,
    ),
    index("site_visits_day_visitor_hash_idx").on(t.day, t.visitorHash),
  ],
);

/**
 * Assistant connections (migration 0028, docs/phases/PHASE_19.md "Workspace
 * scoping"): which workspace an OAuth client such as ChatGPT acts in for a
 * user. One live row (revoked_at null) per (user_id, oauth_client_id), which
 * covers every ChatGPT account and Codex install of that person on that
 * client (decision 18). The consent page writes it; the MCP server reads it
 * by the token's (sub, client_id) on every call and re-reads the membership.
 * A row is revoked, never reused: a revoked row is never made live again.
 * profile_id is a random 16 byte base64url id made once per user and copied
 * into every later row for that user, so get_profile returns the same id
 * across reconnects and workspace changes (OpenAI O1). user_id has no
 * foreign key, as members.user_id. Tenant table: the row's user (while a
 * member) and the workspace's owners and admins read; no client role writes.
 */
export const mcpConnections = pgTable(
  "mcp_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    oauthClientId: text("oauth_client_id").notNull(),
    clientName: text("client_name"),
    profileId: text("profile_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("mcp_connections_live_user_client_uq")
      .on(t.userId, t.oauthClientId)
      .where(sql`${t.revokedAt} is null`),
    index("mcp_connections_user_client_idx").on(t.userId, t.oauthClientId),
    index("mcp_connections_workspace_id_idx").on(t.workspaceId),
    check("mcp_connections_profile_id_check", sql`${t.profileId} ~ '^[A-Za-z0-9_-]{22}$'`),
    check(
      "mcp_connections_lengths_check",
      sql`char_length(${t.oauthClientId}) between 1 and 200 and char_length(coalesce(${t.clientName}, '')) <= 200`,
    ),
  ],
);

// ===========================================================================
// Phase 18 migrations (docs/phases/PHASE_18.md "Data model summary",
// principle 10). Named, never numbered: a lane changes this file, runs
//   pnpm --filter @curvi/db db:generate --name <name>
// and appends its hand written SQL (RLS, policies, grants, functions,
// partial indexes Drizzle cannot express) at the very end of the generated
// file, between these two lines:
//   -- >>> Phase 18 hand written: <name>
//   -- <<< Phase 18 hand written: <name>
// The number is whatever is free when the lane generates. Integrators
// renumber at the final combine, after 0027_site_visits and after PHASE_19's
// mcp_connections (p19/integration merges first), by regenerating from the
// merged schema and re-appending each delimited block. Planned order, which
// production also applies in:
//   1. attribution_and_funnel  P18-01, P18-02  Lane 1 Measure     signup_attributions (tenant); events_funnel_first_uq
//   2. lifecycle_email         P18-06          Lane 3 Email       email_sends, email_suppressions (platform); leads.marketing_consent_at, leads.consent_source
//   3. pack_feedback           P18-05          Lane 6 Concierge   pack_feedback (tenant)
//   4. pack_claims             P18-04          Lane 6 Concierge   pack_claims (platform)
//   5. share_proof             P18-16          Lane 4 Proof       share_links.show_proof
//   6. free_previews           P18-12          Lane 8 Activation  free_previews (platform)
//   7. seller_profile          P18-20          Lane 8 Activation  workspaces.seller_profile
//   8. deploy_restarts         P18-23          Lane 2 Resilience  generation_jobs.restart_count
//   9. referrals               P18-24          Lane 9 Offer       referral_codes (tenant); referrals reworked
// New tables go in their migration's block below, with their inferred row
// types beside them (not in the shared list at the end of this file), so
// lanes never edit the same lines. New columns go on the existing table's
// definition above. Tenant tables carry workspace_id and member policies;
// platform tables keep RLS on with no policies and no client privileges
// (the leads precedent). Each migration gets its packages/db/src test file.
// ===========================================================================

// --- attribution_and_funnel (Lane 1 Measure) ---

/** The cookie choice a signup was sent with; null when none was made yet. */
export type SignupAttributionConsent = "granted" | "denied";
/** How the account was created: email and password, or Google (P18-13). */
export type SignupMethod = "email" | "google";

/**
 * Where a signup came from (docs/phases/PHASE_18.md P18-01): one row per
 * user, written once by the auth callback on a fresh verification over the
 * owner connection from the hint the signup form put in the signup metadata
 * (validated and capped again on the server). self_reported is a seeded
 * signupSourceChoices key, with the short "Other" text beside it; source is
 * the seeded page key of the Start free link the visitor clicked; the UTM
 * tags, ref, share slug, claim and preview come from the signup link;
 * referrer_host, landing_path and first_seen_at come only from the curvi_ft
 * first touch cookie, which exists only after cookie consent. consent is the
 * cookie choice at signup. Tenant table: owners and admins of the workspace
 * read their own row, nobody writes through a client role, and the app never
 * shows it to sellers.
 */
export const signupAttributions = pgTable(
  "signup_attributions",
  {
    userId: uuid("user_id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    selfReported: text("self_reported"),
    selfReportedOther: text("self_reported_other"),
    source: text("source"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmContent: text("utm_content"),
    utmTerm: text("utm_term"),
    ref: text("ref"),
    shareSlug: text("share_slug"),
    claimId: text("claim_id"),
    previewId: text("preview_id"),
    landingPath: text("landing_path"),
    referrerHost: text("referrer_host"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    consent: text("consent").$type<SignupAttributionConsent>(),
    method: text("method").$type<SignupMethod>().notNull().default("email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("signup_attributions_workspace_id_idx").on(t.workspaceId),
    check("signup_attributions_consent_check", sql`${t.consent} is null or ${t.consent} in ('granted', 'denied')`),
    check("signup_attributions_method_check", sql`${t.method} in ('email', 'google')`),
    check(
      "signup_attributions_lengths_check",
      sql`char_length(coalesce(${t.selfReported}, '')) <= 40
        and char_length(coalesce(${t.selfReportedOther}, '')) <= 80
        and char_length(coalesce(${t.source}, '')) <= 40
        and char_length(coalesce(${t.utmSource}, '')) <= 100
        and char_length(coalesce(${t.utmMedium}, '')) <= 100
        and char_length(coalesce(${t.utmCampaign}, '')) <= 100
        and char_length(coalesce(${t.utmContent}, '')) <= 100
        and char_length(coalesce(${t.utmTerm}, '')) <= 100
        and char_length(coalesce(${t.ref}, '')) <= 32
        and char_length(coalesce(${t.shareSlug}, '')) <= 32
        and char_length(coalesce(${t.claimId}, '')) <= 64
        and char_length(coalesce(${t.previewId}, '')) <= 36
        and char_length(coalesce(${t.landingPath}, '')) <= 200
        and char_length(coalesce(${t.referrerHost}, '')) <= 100`,
    ),
  ],
);

export type SignupAttribution = typeof signupAttributions.$inferSelect;
export type NewSignupAttribution = typeof signupAttributions.$inferInsert;

// events_funnel_first_uq (the partial unique index on events (workspace_id,
// name) where name like 'funnel.first_%') is hand written SQL in the
// migration, like 0003's events_billing_dedupe_uq, so the shared events
// definition above stays as it is.
// --- end attribution_and_funnel ---

// --- lifecycle_email (Lane 3 Email) ---

/** Transactional mail (welcome, pack ready) goes to anyone not suppressed
 * for all mail; marketing mail also needs no marketing suppression, the
 * unsubscribe headers and the postal address (P18-06). */
export type EmailSendKind = "transactional" | "marketing";
/** pending: claimed, the Resend call not finished. disabled: the switch was
 * off or the sender was not configured (may be tried again). failed: Resend
 * refused or did not answer (tried again up to the seeded attempts).
 * suppressed and sent are final. */
export type EmailSendStatus = "pending" | "sent" | "failed" | "suppressed" | "disabled";
export type EmailSuppressionScope = "marketing" | "all";
export type EmailSuppressionReason = "unsubscribed" | "bounced" | "complained" | "manual";

/**
 * Every lifecycle email attempt (docs/phases/PHASE_18.md P18-06), one row
 * per dedupe key, so no email is sent twice for one key. It logs mail to
 * leads too, who have no workspace, so it is a platform table like leads:
 * RLS on with no policies and no client privileges. No address is stored:
 * recipient_key is the sha256 of the normalized email (the 0012
 * normalized_email_key rules), and error never carries the address.
 */
export const emailSends = pgTable(
  "email_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recipientKey: text("recipient_key").notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    template: text("template").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    kind: text("kind").$type<EmailSendKind>().notNull(),
    providerId: text("provider_id"),
    status: text("status").$type<EmailSendStatus>().notNull().default("pending"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("email_sends_dedupe_key_uq").on(t.dedupeKey),
    index("email_sends_recipient_key_idx").on(t.recipientKey),
    index("email_sends_workspace_id_idx").on(t.workspaceId),
    index("email_sends_updated_at_idx").on(t.updatedAt),
    check("email_sends_kind_check", sql`${t.kind} in ('transactional', 'marketing')`),
    check("email_sends_status_check", sql`${t.status} in ('pending', 'sent', 'failed', 'suppressed', 'disabled')`),
    check("email_sends_recipient_key_check", sql`${t.recipientKey} ~ '^[0-9a-f]{64}$'`),
    check(
      "email_sends_lengths_check",
      sql`char_length(${t.template}) between 1 and 40
        and char_length(${t.dedupeKey}) between 1 and 200
        and char_length(coalesce(${t.providerId}, '')) <= 100
        and char_length(coalesce(${t.error}, '')) <= 500
        and ${t.attempts} >= 1`,
    ),
  ],
);

export type EmailSend = typeof emailSends.$inferSelect;
export type NewEmailSend = typeof emailSends.$inferInsert;

/**
 * Addresses Curvi must not email (P18-06): a marketing unsubscribe (one
 * click, the unsubscribe page or the settings toggle) or every email after
 * a hard bounce or a spam complaint (the Resend webhook). Keyed like
 * email_sends; a platform table with RLS on, no policies and no client
 * privileges.
 */
export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    recipientKey: text("recipient_key").primaryKey(),
    scope: text("scope").$type<EmailSuppressionScope>().notNull(),
    reason: text("reason").$type<EmailSuppressionReason>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("email_suppressions_scope_check", sql`${t.scope} in ('marketing', 'all')`),
    check(
      "email_suppressions_reason_check",
      sql`${t.reason} in ('unsubscribed', 'bounced', 'complained', 'manual')`,
    ),
    check("email_suppressions_recipient_key_check", sql`${t.recipientKey} ~ '^[0-9a-f]{64}$'`),
  ],
);

export type EmailSuppression = typeof emailSuppressions.$inferSelect;
export type NewEmailSuppression = typeof emailSuppressions.$inferInsert;
// leads.marketing_consent_at and leads.consent_source are on the leads
// definition above.
// --- end lifecycle_email ---

// --- pack_feedback (Lane 6 Concierge) ---

/** "Would you use these files in a live listing?" (P18-05). */
export type PackFeedbackUsable = "yes" | "some" | "not_yet";
/** "Would you pay for packs like this?" (P18-05). */
export type PackFeedbackWouldPay = "yes" | "maybe" | "no";

/**
 * One member's answer about one finished pack (docs/phases/PHASE_18.md
 * P18-05): would they use the files live, would they pay, what would make
 * them better, and whether Curvi may quote them with the name they typed.
 * One answer per pack and person. Tenant table: members of the workspace
 * read their workspace's rows; the server writes over the owner connection
 * after it checks membership, so no client role inserts, edits or deletes.
 */
export const packFeedback = pgTable(
  "pack_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => generationJobs.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    usable: text("usable").$type<PackFeedbackUsable>().notNull(),
    wouldPay: text("would_pay").$type<PackFeedbackWouldPay>(),
    comment: text("comment"),
    quoteConsent: boolean("quote_consent").notNull().default(false),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pack_feedback_job_user_uq").on(t.jobId, t.userId),
    index("pack_feedback_workspace_id_idx").on(t.workspaceId),
    index("pack_feedback_created_at_idx").on(t.createdAt),
    check("pack_feedback_usable_check", sql`${t.usable} in ('yes', 'some', 'not_yet')`),
    check("pack_feedback_would_pay_check", sql`${t.wouldPay} is null or ${t.wouldPay} in ('yes', 'maybe', 'no')`),
    check(
      "pack_feedback_lengths_check",
      sql`char_length(coalesce(${t.comment}, '')) <= 500 and char_length(coalesce(${t.displayName}, '')) <= 60`,
    ),
    // A quote needs words to quote.
    check(
      "pack_feedback_quote_check",
      sql`not ${t.quoteConsent} or char_length(btrim(coalesce(${t.comment}, ''))) > 0`,
    ),
  ],
);

export type PackFeedback = typeof packFeedback.$inferSelect;
export type NewPackFeedback = typeof packFeedback.$inferInsert;
// --- end pack_feedback ---

// --- pack_claims (Lane 6 Concierge) ---

/**
 * A prospect pack the operator made for concierge outreach
 * (docs/phases/PHASE_18.md P18-04): the pack (job_id) lives in the
 * operator's workspace (staff_workspace_id), its share page is link only,
 * and the claim link carries a token whose sha256 is token_hash, so the
 * token itself is never stored. prospect_label is the store name the
 * operator typed. A claim is redeemed once, by the new account it attributes
 * (claimed_by_workspace_id, claimed_at), and can be taken down by anyone
 * holding the link (taken_down_at). Platform table: RLS on, no policies, no
 * client privileges (the leads precedent); only the server's owner
 * connection reads or writes it.
 */
export const packClaims = pgTable(
  "pack_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => generationJobs.id, { onDelete: "cascade" }),
    staffWorkspaceId: uuid("staff_workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    prospectLabel: text("prospect_label").notNull(),
    productSourceUrl: text("product_source_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    claimedByWorkspaceId: uuid("claimed_by_workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    takenDownAt: timestamp("taken_down_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("pack_claims_token_hash_uq").on(t.tokenHash),
    uniqueIndex("pack_claims_job_id_uq").on(t.jobId),
    index("pack_claims_staff_workspace_id_idx").on(t.staffWorkspaceId),
    index("pack_claims_claimed_by_workspace_id_idx").on(t.claimedByWorkspaceId),
    check("pack_claims_token_hash_check", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "pack_claims_lengths_check",
      sql`char_length(btrim(${t.prospectLabel})) between 1 and 80 and char_length(coalesce(${t.productSourceUrl}, '')) <= 2048`,
    ),
    // A claiming workspace always comes with its time (the workspace can
    // later be deleted, which keeps the time).
    check("pack_claims_claim_check", sql`${t.claimedByWorkspaceId} is null or ${t.claimedAt} is not null`),
  ],
);

export type PackClaim = typeof packClaims.$inferSelect;
export type NewPackClaim = typeof packClaims.$inferInsert;
// --- end pack_claims ---

// --- free_previews (Lane 8 Activation) ---
export type FreePreviewStatus = "running" | "done" | "blocked" | "failed" | "claimed";

/**
 * One free white main image made before signup (docs/phases/PHASE_18.md
 * P18-12). A platform table: no workspace until a new account claims it,
 * RLS on with no policies and no client privileges (the leads precedent).
 * The files live under anon/preview/{id}/ in R2 and expire with the row.
 * ip_hash is a 32 hex digest under a salt that changes every UTC day and is
 * never stored, so it can group one day's previews and nothing else;
 * email_key is the sha256 of the email that unlocked the full size file.
 */
export const freePreviews = pgTable(
  "free_previews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ipHash: text("ip_hash").notNull(),
    status: text("status").$type<FreePreviewStatus>().notNull().default("running"),
    blockedReason: text("blocked_reason"),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    /** The stored original's format (jpeg, png or webp after ingest). */
    sourceFormat: text("source_format"),
    /** The full size main image's format, as encoded for amazon.main. */
    mainFormat: text("main_format"),
    emailKey: text("email_key"),
    claimedWorkspaceId: uuid("claimed_workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("free_previews_status_check", sql`${t.status} in ('running', 'done', 'blocked', 'failed', 'claimed')`),
    check("free_previews_ip_hash_check", sql`${t.ipHash} ~ '^[0-9a-f]{32}$'`),
    check("free_previews_email_key_check", sql`${t.emailKey} is null or ${t.emailKey} ~ '^[0-9a-f]{64}$'`),
    check(
      "free_previews_source_format_check",
      sql`${t.sourceFormat} is null or ${t.sourceFormat} in ('jpeg', 'png', 'webp')`,
    ),
    check("free_previews_main_format_check", sql`${t.mainFormat} is null or ${t.mainFormat} in ('jpeg', 'png')`),
    check(
      "free_previews_lengths_check",
      sql`char_length(coalesce(${t.blockedReason}, '')) <= 200 and ${t.costMicros} >= 0`,
    ),
    check(
      "free_previews_claim_check",
      sql`(${t.status} = 'claimed') = (${t.claimedAt} is not null)`,
    ),
    index("free_previews_created_at_idx").on(t.createdAt),
    index("free_previews_expires_at_idx").on(t.expiresAt),
    index("free_previews_claimed_workspace_id_idx").on(t.claimedWorkspaceId),
  ],
);

export type FreePreview = typeof freePreviews.$inferSelect;
export type NewFreePreview = typeof freePreviews.$inferInsert;
// --- end free_previews ---

// --- referrals (Lane 9 Offer) ---

/**
 * One invite code per workspace (docs/phases/PHASE_18.md P18-24), issued
 * lazily on /app/settings/referrals: lower case letters and digits, the
 * format the ref landing parameter carries (apps/web/src/lib/attribution.ts).
 * Tenant table: members of the workspace read their own code; only the
 * server writes. The reworked referrals table above references code.
 */
export const referralCodes = pgTable(
  "referral_codes",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("referral_codes_code_uq").on(t.code),
    check("referral_codes_code_check", sql`${t.code} ~ '^[a-z0-9]{4,32}$'`),
  ],
);

export type ReferralCode = typeof referralCodes.$inferSelect;
export type NewReferralCode = typeof referralCodes.$inferInsert;

// credit_ledger_referral_step_uq (a partial unique index on credit_ledger
// (step_key) where reason = 'referral' and step_key is not null, so each
// reward and each reversal is written once per referral) is hand written
// SQL in the migration, so the shared credit_ledger definition above stays
// as it is.
// --- end referrals ---

// Inferred row types.
export type McpConnection = typeof mcpConnections.$inferSelect;
export type NewMcpConnection = typeof mcpConnections.$inferInsert;
export type SiteVisit = typeof siteVisits.$inferSelect;
export type NewSiteVisit = typeof siteVisits.$inferInsert;
export type SiteVisitSalt = typeof siteVisitSalts.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type Favorite = typeof favorites.$inferSelect;
export type NewFavorite = typeof favorites.$inferInsert;
export type UploadPreflight = typeof uploadPreflights.$inferSelect;
export type NewUploadPreflight = typeof uploadPreflights.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type Member = typeof members.$inferSelect;
export type NewMember = typeof members.$inferInsert;
export type BrandKit = typeof brandKits.$inferSelect;
export type NewBrandKit = typeof brandKits.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type SourceMediaRow = typeof sourceMedia.$inferSelect;
export type NewSourceMediaRow = typeof sourceMedia.$inferInsert;
export type Job = typeof generationJobs.$inferSelect;
export type NewJob = typeof generationJobs.$inferInsert;
export type JobStep = typeof jobSteps.$inferSelect;
export type NewJobStep = typeof jobSteps.$inferInsert;
export type Asset = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;
export type AssetVariant = typeof assetVariants.$inferSelect;
export type NewAssetVariant = typeof assetVariants.$inferInsert;
export type ChannelSpecRow = typeof channelSpecs.$inferSelect;
export type NewChannelSpecRow = typeof channelSpecs.$inferInsert;
export type Recipe = typeof recipes.$inferSelect;
export type NewRecipe = typeof recipes.$inferInsert;
export type CreditLedgerEntry = typeof creditLedger.$inferSelect;
export type NewCreditLedgerEntry = typeof creditLedger.$inferInsert;
export type PackFile = typeof packFiles.$inferSelect;
export type NewPackFile = typeof packFiles.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type Referral = typeof referrals.$inferSelect;
export type NewReferral = typeof referrals.$inferInsert;
export type ShareLink = typeof shareLinks.$inferSelect;
export type NewShareLink = typeof shareLinks.$inferInsert;
export type GalleryItem = typeof galleryItems.$inferSelect;
export type NewGalleryItem = typeof galleryItems.$inferInsert;
export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type Integration = typeof integrations.$inferSelect;
export type NewIntegration = typeof integrations.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type PlatformSetting = typeof platformSettings.$inferSelect;
export type NewPlatformSetting = typeof platformSettings.$inferInsert;
export type SignupGrant = typeof signupGrants.$inferSelect;
export type NewSignupGrant = typeof signupGrants.$inferInsert;
export type CancelFlow = typeof cancelFlows.$inferSelect;
export type NewCancelFlow = typeof cancelFlows.$inferInsert;
export type ChurnScore = typeof churnScores.$inferSelect;
export type NewChurnScore = typeof churnScores.$inferInsert;
export type TermsAcceptance = typeof termsAcceptances.$inferSelect;
export type NewTermsAcceptance = typeof termsAcceptances.$inferInsert;

// ===========================================================================
// Phase 20 migrations (docs/phases/PHASE_20.md "Data model summary",
// principle 10). Named, never numbered: a lane changes this file, runs
//   pnpm --filter @curvi/db db:generate --name <name>
// on top of the newest migration it has (0027_site_visits on main), and
// appends its hand written SQL (RLS, policies, grants, functions, data
// copies Drizzle cannot express) at the very end of the generated file,
// between these two lines:
//   -- >>> Phase 20 hand written: <name>
//   -- <<< Phase 20 hand written: <name>
// The number is whatever is free when the lane generates. PHASE_19
// (0028_mcp_connections) and PHASE_18 (0029 to 0037) merged first, so at the
// final combine (release/2026-10-02) Release 2's two became
// 0038_ops_switches_and_audit and 0039_billing_terms, each snapshot chained
// after 0037's. Later Phase 20 migrations generate on top of 0039.
// Production applies them in numeric order, each after a fresh backup.
//
// Planned order (release, lane, items, change):
//   1. billing_terms          R2  Lane 2 Billing terms    P20-05, P20-07  credit_ledger.expires_at null where reason = 'topup'; subscriptions.cadence; billing_consents (tenant)
//   2. ops_switches_and_audit R2  Lane 5 Operator basics  P20-20, P20-66  copy each switch row to its ops: key (expand only, old key kept); ops_audit (platform)
//   3. billing_schedule       R3  Lane 2b Billing later   P20-06, P20-09  subscriptions.pending_tier, pending_cadence, pending_at, pending_schedule_id; credit_ledger.note
//   4. ops_switches_contract  R3  Lane 5b Deploy          P20-20          delete the old switch keys, each statement with a "-- contract:" comment
//   5. runner_columns         R3  Lane 8 Runner           P20-32, 33, 35  generation_jobs.heartbeat_at, runner_id, run_payload (if P18-23 lacks it), started_at, finished_at; the partial live index
//   6. retention_indexes      R3  Lane 10 Schedule        P20-39          indexes on events(at), spend_cap_counters(updated_at), upload_preflights(updated_at)
//   7. ops_alerts_gallery     R3  Lane 13 Cockpit         P20-47, P20-50  ops_alerts (platform); gallery_items.review_status, reviewed_at, reviewed_by; the new public policy
//   8. disposable_domains     R4  Lane 15 Security        P20-30          disposable_email_domains (platform); the new signup grant function version
//   9. pack_batches           R5  Batch 5                 P20-60, P20-61  pack_batches (tenant); generation_jobs.batch_id, listing_copy
//  10. job_checkpoint         R5  Batch 5                 P20-64          generation_jobs.checkpoint
// Triggered (P2), numbered when their trigger fires:
//      breaker_state          P20-36  breaker_state (platform)
//      products_archive       P20-43  products.archived_at and its index
//      workspace_invites      P20-59  workspace_invites (tenant)
// The two Release 2 migrations may generate in either order; each takes the
// next free number.
//
// Rules for every Phase 20 migration (principles 5 and 10):
// - New tables go in their migration's block below, with their inferred row
//   types beside them (not in the shared list above), so lanes never edit
//   the same lines. New columns go on the existing table's definition.
// - Tenant tables carry workspace_id and member policies, and get a
//   packages/db/src/<name>.test.ts. Platform tables keep RLS on with no
//   client policies and REVOKE ALL from anon and authenticated (the 0010 and
//   0027 pattern), with a test that client roles can neither read nor write.
// - Every new table gets 0028_mcp_connections' restrictive no_oauth_clients
//   policy in its own migration's hand written block, with 0028's DO block
//   (FOREACH t IN ARRAY ARRAY['<table>'], guarded by the authenticated role
//   so PGlite without it still loads; see 0037_referrals or 0039_billing_terms).
//   packages/db/src/mcp-connections.test.ts fails for a public table without it.
// - Expand first, contract later: no DROP, RENAME, ALTER ... TYPE, or
//   DELETE or UPDATE on platform_settings, except in a statement marked
//   with a "-- contract:" comment (P20-12's lint).
// - Never write an ops: row from the seed; a migration copies existing rows
//   to ops: keys with ON CONFLICT DO NOTHING.
// ===========================================================================

// --- billing_terms (Lane 2 Billing terms): billing_consents ---

/**
 * The renewal consent a buyer gave in Stripe Checkout (docs/phases/
 * PHASE_20.md P20-07): one row per completed plan Checkout Session whose
 * terms checkbox was accepted, written by the Stripe webhook with the
 * disclosure version and hash the session carried in its metadata (never
 * computed at webhook time, so a replay after a wording change still records
 * what the buyer saw). workspace_id is set null when the workspace is
 * deleted, because California asks for the record to outlive the account
 * (renewalNotices.consentRecordYears). Tenant table: owners and admins of
 * the workspace read it, no client writes, no_oauth_clients.
 */
export const billingConsents = pgTable(
  "billing_consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    userId: uuid("user_id"),
    /** normalized_email_key (migration 0012) of the buyer's email. */
    emailKey: text("email_key"),
    /** The buyer's email as given, so the record shows who agreed without
     * the account (law and copy review major 8). */
    email: text("email"),
    /** The Stripe customer the plan belongs to. */
    stripeCustomerId: text("stripe_customer_id"),
    /** A plan bought in Checkout: its session. */
    checkoutSessionId: text("checkout_session_id"),
    /** A plan change a subscriber started from /app/billing, with the
     * terms beside the button, and confirmed in the portal: its portal
     * session. Exactly one of the two session ids is set. */
    portalSessionId: text("portal_session_id"),
    tier: text("tier").notNull(),
    cadence: text("cadence").$type<"monthly" | "annual">().notNull(),
    /** What the session charged, in dollars. */
    amountUsd: numeric("amount_usd", { precision: 10, scale: 2, mode: "number" }),
    disclosureVersion: text("disclosure_version").notNull(),
    disclosureSha256: text("disclosure_sha256").notNull(),
    /** The exact text shown: Checkout's custom_text (beside the pay button,
     * then the checkbox) copied from the session, or the terms beside the
     * plan change button. Its sha256 is disclosure_sha256. */
    disclosureText: text("disclosure_text"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("billing_consents_checkout_session_uq").on(t.checkoutSessionId),
    uniqueIndex("billing_consents_portal_session_uq").on(t.portalSessionId),
    index("billing_consents_workspace_id_idx").on(t.workspaceId),
    check(
      "billing_consents_one_session",
      sql`(${t.checkoutSessionId} IS NULL) <> (${t.portalSessionId} IS NULL)`,
    ),
  ],
);

export type BillingConsentRow = typeof billingConsents.$inferSelect;
export type NewBillingConsentRow = typeof billingConsents.$inferInsert;

// --- end billing_terms ---

// --- ops_switches_and_audit (Lane 5 Operator basics): ops_audit ---

/**
 * The operator audit trail (docs/phases/PHASE_20.md principle 9, P20-66):
 * one row per operator mutation (a switch, a credit grant, a requeue, the
 * release script's deploy_pending writes), written by writeOpsAudit
 * (apps/web/src/lib/ops/audit.ts) in the same transaction as the change.
 * workspace_id has no foreign key, so deleting a workspace never deletes
 * its audit trail. detail holds amounts, old and new values and notes,
 * never secrets or customer content. Platform table: RLS on with no client
 * policies, no anon or authenticated privileges and the no_oauth_clients
 * policy; only the owner connection reads or writes it. Not the events
 * table, which members can insert into and which cascades on workspace
 * delete.
 */
export const opsAudit = pgTable(
  "ops_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    operatorEmail: text("operator_email").notNull(),
    action: text("action").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id"),
    workspaceId: uuid("workspace_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    forced: boolean("forced").notNull().default(false),
  },
  (t) => [
    check(
      "ops_audit_lengths_check",
      sql`char_length(${t.operatorEmail}) between 3 and 320 and char_length(${t.action}) between 1 and 64 and char_length(${t.targetKind}) between 1 and 64 and char_length(coalesce(${t.targetId}, '')) <= 200`,
    ),
    index("ops_audit_at_idx").on(t.at),
    index("ops_audit_workspace_id_idx").on(t.workspaceId),
  ],
);

export type OpsAuditRow = typeof opsAudit.$inferSelect;
export type NewOpsAuditRow = typeof opsAudit.$inferInsert;

// --- end ops_switches_and_audit ---

// --- ops_alerts_gallery (Lane 13 Cockpit): ops_alerts ---

/** Platform alert history. A recurrence after resolution gets a new row;
 * the partial unique index prevents concurrent ticks opening duplicates. */
export const opsAlerts = pgTable("ops_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  rule: text("rule").notNull(),
  subject: text("subject").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  status: text("status").$type<"open" | "resolved">().notNull().default("open"),
  count: integer("count").notNull().default(1),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("ops_alerts_open_rule_subject_uq").on(t.rule, t.subject).where(sql`${t.status} = 'open'`),
  index("ops_alerts_resolved_at_idx").on(t.resolvedAt),
  check("ops_alerts_status", sql`${t.status} IN ('open', 'resolved')`),
  check("ops_alerts_count_positive", sql`${t.count} > 0`),
  check("ops_alerts_detail_object", sql`jsonb_typeof(${t.detail}) = 'object'`),
]);

export type OpsAlert = typeof opsAlerts.$inferSelect;
export type NewOpsAlert = typeof opsAlerts.$inferInsert;
// --- end ops_alerts_gallery ---

// --- disposable_domains (Lane 15 Security): disposable_email_domains ---

/** Seeded platform list, consulted by the signup grant function even when
 * signup happens directly through Supabase Auth. No client privileges. */
export const disposableEmailDomains = pgTable("disposable_email_domains", {
  domain: text("domain").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("disposable_email_domains_normalized", sql`${t.domain} = lower(btrim(${t.domain})) AND char_length(${t.domain}) BETWEEN 1 AND 253 AND ${t.domain} ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'`),
]);

export type DisposableEmailDomain = typeof disposableEmailDomains.$inferSelect;
export type NewDisposableEmailDomain = typeof disposableEmailDomains.$inferInsert;
// --- end disposable_domains ---

// --- pack_batches (Batch 5): pack_batches ---
// --- end pack_batches ---

// --- breaker_state (triggered): breaker_state ---
// --- end breaker_state ---

// --- workspace_invites (triggered): workspace_invites ---
// --- end workspace_invites ---

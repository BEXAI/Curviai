import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
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
}

export interface JobInventory {
  version: 1;
  photos: JobInventoryPhoto[];
}

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("free"),
  stripeCustomerId: text("stripe_customer_id"),
  shopifyShop: text("shopify_shop"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("products_workspace_id_idx").on(t.workspaceId)],
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "source_media_angle_check",
      sql`${t.angle} is null or ${t.angle} in ('front', 'back', 'side', 'detail', 'in_the_box', 'scale')`,
    ),
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
    uniqueIndex("generation_jobs_workspace_idempotency_key_uq").on(t.workspaceId, t.idempotencyKey),
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
});

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
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("credit_ledger_workspace_id_idx").on(t.workspaceId),
    index("credit_ledger_job_id_idx").on(t.jobId),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("subscriptions_workspace_id_idx").on(t.workspaceId),
    // One active subscription per workspace.
    uniqueIndex("subscriptions_one_active_per_workspace_uq")
      .on(t.workspaceId)
      .where(sql`status = 'active'`),
  ],
);

export const referrals = pgTable(
  "referrals",
  {
    code: text("code").primaryKey(),
    referrerWorkspaceId: uuid("referrer_workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    referredWorkspaceId: uuid("referred_workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    rewardedAt: timestamp("rewarded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("referrals_referrer_workspace_id_idx").on(t.referrerWorkspaceId),
    index("referrals_referred_workspace_id_idx").on(t.referredWorkspaceId),
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
    consentAt: timestamp("consent_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("gallery_items_workspace_id_idx").on(t.workspaceId),
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
  },
  (t) => [uniqueIndex("leads_email_uq").on(t.email)],
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
  (t) => [index("events_workspace_id_idx").on(t.workspaceId)],
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
    reason: text("reason").$type<CancelReason>().notNull(),
    detail: text("detail"),
    fromTier: text("from_tier"),
    toTier: text("to_tier"),
    offersShown: jsonb("offers_shown").$type<string[]>(),
    outcome: text("outcome").$type<CancelOutcome>().notNull(),
    stripeApplied: boolean("stripe_applied").notNull().default(false),
    stripeSubscriptionId: text("stripe_subscription_id"),
    /** When a pause ends or a cancellation takes effect. */
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
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
 * (auth callback), or the first signed in visit to /app for an account that
 * has no record yet. */
export type TermsAcceptanceSource = "signup_callback" | "first_app_visit";

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

// Inferred row types.
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

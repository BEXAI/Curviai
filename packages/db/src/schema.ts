import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
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
export type LedgerSource = "stripe" | "shopify" | "system";
export type SubscriptionProvider = "stripe" | "shopify";
export type IntegrationKind = "shopify" | "amazon" | "gdrive" | "dropbox" | "canva";
export type ChurnBand = "healthy" | "watch" | "at_risk";

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("source_media_workspace_id_idx").on(t.workspaceId),
    index("source_media_product_id_idx").on(t.productId),
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
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
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
    idempotencyKey: text("idempotency_key").unique(),
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
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("generation_jobs_workspace_id_idx").on(t.workspaceId),
    index("generation_jobs_product_id_idx").on(t.productId),
    index("generation_jobs_status_idx").on(t.status),
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

export const shareLinks = pgTable(
  "share_links",
  {
    slug: text("slug").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    beforeMediaId: uuid("before_media_id").references(() => sourceMedia.id, {
      onDelete: "set null",
    }),
    views: integer("views").notNull().default(0),
    isPublic: boolean("public").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("share_links_workspace_id_idx").on(t.workspaceId)],
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
  (t) => [index("gallery_items_workspace_id_idx").on(t.workspaceId)],
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

export const churnScores = pgTable("churn_scores", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  score: integer("score"),
  signals: jsonb("signals").$type<Record<string, unknown>>(),
  band: text("band").$type<ChurnBand>(),
  computedAt: timestamp("computed_at", { withTimezone: true }),
});

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
export type Integration = typeof integrations.$inferSelect;
export type NewIntegration = typeof integrations.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type ChurnScore = typeof churnScores.$inferSelect;
export type NewChurnScore = typeof churnScores.$inferInsert;

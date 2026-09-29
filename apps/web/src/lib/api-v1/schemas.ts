/**
 * The public API v1 shapes (PHASE_16 workstream 5). One zod schema per
 * request and response: the routes and the MCP tools parse with them, the
 * OpenAPI document (./openapi) and the MCP tool schemas are generated from
 * them, and the contract tests check every answer against them, so the
 * document can never drift from what the server does.
 */

import { z } from "zod";
import { BUNDLE_KEYS, OutputOptionsInput } from "@curvi/pipeline/output-options";
import { MAX_PACK_PHOTOS } from "@/lib/validation/seller-inputs";
import {
  angleRoleSchema,
  endorsementLinesSchema,
  sellerLinesSchema,
  skuSchema,
} from "@/lib/validation/seller-inputs";
import { productIdSchema } from "@/lib/validation/ids";

/** Longest base64 photo string a request may carry (a 25 MB photo). */
export const MAX_PHOTO_BASE64_CHARS = 34_000_000;

export const PhotoInput = z
  .object({
    url: z.string().trim().min(1).max(2048).optional().describe("A public https link to a JPEG, PNG, WEBP, GIF or TIFF photo."),
    data: z
      .string()
      .min(1)
      .max(MAX_PHOTO_BASE64_CHARS)
      .optional()
      .describe("The photo bytes, base64 encoded. Send url or data, not both."),
    angle: angleRoleSchema.optional().describe("What the photo shows, when it is not the front."),
  })
  .strict()
  .refine((photo) => (photo.url === undefined) !== (photo.data === undefined), "Send a url or data for each photo, not both.");
export type PhotoInput = z.infer<typeof PhotoInput>;

export const CreatePackRequest = z
  .object({
    channels: z
      .array(z.string().min(1).max(64))
      .min(1)
      .max(24)
      .describe("Channel spec ids such as amazon.main, or channel names such as amazon for every live spec of it."),
    photos: z.array(PhotoInput).max(MAX_PACK_PHOTOS).optional().describe("Real product photos. The product is never redrawn."),
    productId: productIdSchema.optional().describe("An existing product id, or new (the default)."),
    title: z.string().trim().min(1).max(120).optional().describe("The new product's title."),
    note: z.string().trim().max(2000).optional().describe("What the seller wants, in their words."),
    sku: skuSchema.optional(),
    boxContents: sellerLinesSchema.optional(),
    comparisonFacts: sellerLinesSchema.optional(),
    endorsements: endorsementLinesSchema.optional(),
    bundle: z.enum(BUNDLE_KEYS).optional().describe("How much the pack makes. everything is the default."),
    outputOptions: OutputOptionsInput.optional(),
  })
  .strict();
export type CreatePackRequest = z.input<typeof CreatePackRequest>;

export const ShotCompliance = z.object({
  pass: z.boolean(),
  fillPct: z.number().nullable(),
  background: z.array(z.number()).nullable(),
});

export const PackShot = z.object({
  id: z.string(),
  type: z.string(),
  status: z.enum(["pending", "generating", "qc", "done", "failed", "needs_review", "skipped"]),
  channels: z.array(z.string()),
  credits: z.number(),
  note: z.string().nullable(),
  compliance: ShotCompliance.nullable(),
});

export const PACK_STATUSES = [
  "queued",
  "analyzing",
  "planning",
  "generating",
  "qc",
  "packaging",
  "done",
  "failed",
  "canceled",
] as const;

export const Pack = z.object({
  id: z.string(),
  status: z.enum(PACK_STATUSES),
  /** True once the pack stopped: done, failed or canceled. */
  finished: z.boolean(),
  productId: z.string(),
  productTitle: z.string(),
  channels: z.array(z.string()),
  creditsReserved: z.number(),
  creditsCharged: z.number(),
  createdAt: z.string(),
  error: z.string().nullable(),
  shots: z.array(PackShot),
  links: z.object({ self: z.string(), files: z.string() }),
});
export type Pack = z.infer<typeof Pack>;

export const PackResponse = z.object({ pack: Pack, replayed: z.boolean().optional() });

export const PackFile = z.object({
  id: z.string(),
  name: z.string(),
  channel: z.string().nullable(),
  specId: z.string().nullable(),
  kind: z.enum(["image", "zip", "report"]),
  bytes: z.number().nullable(),
  /** A signed download link, or null when files are not stored (demo). */
  url: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

export const PackFilesResponse = z.object({
  packId: z.string(),
  status: z.enum(PACK_STATUSES),
  files: z.array(PackFile),
  notice: z.string().optional(),
});

export const MainImageCheckRequest = z
  .object({
    url: z.string().trim().min(1).max(2048).optional().describe("A public https link to the main image."),
    data: z.string().min(1).max(MAX_PHOTO_BASE64_CHARS).optional().describe("The image bytes, base64 encoded."),
  })
  .strict()
  .refine((body) => (body.url === undefined) !== (body.data === undefined), "Send a url or data, not both.");

export const MainImageCheckResponse = z.object({
  pass: z.boolean(),
  summary: z.string(),
  width: z.number(),
  height: z.number(),
  checks: z.array(
    z.object({
      key: z.enum(["resolution", "background", "fill"]),
      label: z.string(),
      pass: z.boolean(),
      measured: z.string(),
    }),
  ),
  rules: z.object({ minLongSide: z.number(), fillMinPercent: z.number(), fillMaxPercent: z.number() }),
});

export const Channel = z.object({
  id: z.string(),
  channel: z.string(),
  name: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  availability: z.enum(["available", "coming_soon", "upgrade_required"]),
  upgradeTo: z.string().nullable(),
});

export const ChannelsResponse = z.object({
  channels: z.array(Channel),
  bundles: z.array(z.object({ key: z.string(), label: z.string() })),
});

export const ErrorResponse = z.object({
  error: z.string(),
  reason: z.string(),
  issues: z.array(z.string()).optional(),
  existingPackId: z.string().optional(),
  retryAfterSeconds: z.number().optional(),
});
export type ErrorBody = z.infer<typeof ErrorResponse>;

/** Schemas the OpenAPI document names under components.schemas. */
export const COMPONENT_SCHEMAS = {
  CreatePackRequest,
  PackResponse,
  PackFilesResponse,
  MainImageCheckRequest,
  MainImageCheckResponse,
  ChannelsResponse,
  Error: ErrorResponse,
} as const;

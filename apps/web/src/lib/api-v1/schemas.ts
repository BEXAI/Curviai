/**
 * The public API v1 shapes (PHASE_16 workstream 5). One zod schema per
 * request and response: the routes and the MCP tools parse with them, the
 * OpenAPI document (./openapi) and the MCP tool schemas are generated from
 * them, and the contract tests check every answer against them, so the
 * document can never drift from what the server does.
 */

import { z } from "zod";
import { BUNDLE_KEYS, LOOK_KEYS, OutputOptionsInput } from "@curvi/pipeline/output-options";
import { channelChoices, moodChoices, questionSet } from "@curvi/pipeline/seed";
import { MAX_PACK_PHOTOS } from "@/lib/validation/seller-inputs";
import {
  angleRoleSchema,
  endorsementLinesSchema,
  sellerLinesSchema,
  skuSchema,
} from "@/lib/validation/seller-inputs";
import { productIdSchema } from "@/lib/validation/ids";
import { checkerChannels } from "@/lib/tools/checker-rules";

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

/** Longest file link taken from a chat attachment. OpenAI does not document
 * the length, so the cap is generous (PHASE_19 P19-15). */
export const MAX_FILE_URL_CHARS = 8_192;

/**
 * A file the user attached in ChatGPT, sent in a top level field the tool
 * lists in _meta["openai/fileParams"] (PHASE_19 P19-15; docs/verification.md,
 * "PHASE_19: ChatGPT and Codex plugin", O2): ChatGPT always includes
 * download_url and file_id and may omit mime_type and file_name. Unknown keys
 * are stripped, not refused, so a field the client adds later never breaks
 * a call. The photo's type comes from its bytes, never from mime_type, and
 * download_url and file_id are never stored or logged.
 */
export const OpenAIFileObject = z.object({
  download_url: z
    .url({ protocol: /^https$/ })
    .max(MAX_FILE_URL_CHARS)
    .describe("The temporary https link ChatGPT gives for the attached file."),
  file_id: z.string().min(1).max(256).describe("ChatGPT's id for the attached file."),
  mime_type: z.string().max(255).optional(),
  file_name: z.string().max(255).optional(),
});
export type OpenAIFileObject = z.infer<typeof OpenAIFileObject>;

/** Request fields that carry chat attachments. The REST document leaves them
 * out and the REST routes refuse them (the public API v1 is unchanged by
 * PHASE_19); only the MCP tools take them (P19-15). */
export const CHAT_FILE_FIELDS = ["images", "image"] as const;

/**
 * Whether the MCP tools take chat attachments (PHASE_19 P19-15). On since
 * the attachment fetch landed (lib/api-v1/photos.ts): the tool arguments,
 * the inputSchema fields and _meta["openai/fileParams"] carry images and
 * image. False puts back the earlier state, where tools/list leaves the
 * fields out and tools/call refuses them as unknown keys.
 */
export const CHAT_FILES_WIRED: boolean = true;

/** Seed option values as a zod enum (rule 2: the choices live in the seed). */
function seedEnum(values: readonly string[]) {
  return z.enum(values as [string, ...string[]]);
}

/**
 * The question step's answers for callers with no upload preflight
 * (PHASE_16 workstream 5): the seed's channel and mood choices by value.
 * The target, use and audience questions need the photo's inventory or
 * model written options, so they are not offered here.
 */
export const PackAnswers = z
  .object({
    channels: seedEnum([...channelChoices.map((c) => c.value), questionSet.allOption.value])
      .optional()
      .describe("Where the seller will sell, as a marketplace name, or all."),
    mood: seedEnum(moodChoices.map((m) => m.value))
      .optional()
      .describe("The scene mood. It sets the scene style and the first lifestyle scene unless the output options name a scene style."),
  })
  .strict();
export type PackAnswers = z.infer<typeof PackAnswers>;

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
    look: z
      .enum(LOOK_KEYS)
      .optional()
      .describe("A starting style. The server fills the output options from the look's preset; outputOptions fields sent with it win."),
    outputOptions: OutputOptionsInput.optional(),
    answers: PackAnswers.optional().describe("Answers to the question step. They weigh more than the note."),
    images: z
      .array(OpenAIFileObject)
      .min(1)
      .max(MAX_PACK_PHOTOS)
      .optional()
      .describe("Product photos attached in the chat. Send photos or images, not both."),
  })
  .strict();
export type CreatePackRequest = z.input<typeof CreatePackRequest>;

/** The pack request without the chat attachment field: the body the REST
 * document describes, and the create_pack arguments until P19-15. */
export const CreatePackRequestNoFiles = CreatePackRequest.omit({ images: true });

/** The color inside the product measured on the shot's file (P18-08):
 * CIEDE2000 inside the product mask of the delivered bytes. */
export const ShotFidelity = z.object({
  meanDeltaE: z.number().describe("Average color difference inside the product, to 2 decimals."),
  maxDeltaE: z.number().describe("Largest single pixel color difference inside the product, to 1 decimal."),
  exactByteShare: z.number().describe("Share of compared pixels whose bytes match the product reference, 0 to 1."),
  maskArea: z.number().describe("Pixels compared."),
  threshold: z.number().describe("The average the file had to stay under: 3 for main images, 5 for the rest."),
  maxDeltaELimit: z.number().describe("The single pixel ceiling the file had to stay under."),
  kind: z.enum(["main", "other"]),
  exact: z.boolean().describe("True only when the file is the seller's upload byte for byte."),
});

export const ShotCompliance = z.object({
  pass: z.boolean(),
  fillPct: z.number().nullable(),
  background: z.array(z.number()).nullable(),
  fidelity: ShotFidelity.nullable().describe("Null when the shot's file was not measured against the product."),
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

const mainImageSourceFields = {
  url: z.string().trim().min(1).max(2048).optional().describe("A public https link to the main image."),
  data: z.string().min(1).max(MAX_PHOTO_BASE64_CHARS).optional().describe("The image bytes, base64 encoded."),
};

const MAIN_IMAGE_ONE_SOURCE = "Send a url or data, not both.";

/** Only channels with verified checker rules are advertised or accepted.
 * Omitted channel retains the existing Amazon default. */
const mainImageChannel = z
  .enum(checkerChannels().flatMap((channel) => [channel.key, channel.specId]))
  .optional()
  .describe("The marketplace or main image spec to check, from the verified choices. Omit for Amazon.");

/** Exactly one image source: url, data or (PHASE_19) an attached image. */
function oneMainImageSource(body: { url?: unknown; data?: unknown; image?: unknown }): boolean {
  return [body.url, body.data, body.image].filter((source) => source !== undefined).length === 1;
}

export const MainImageCheckRequest = z
  .object({
    ...mainImageSourceFields,
    channel: mainImageChannel,
    image: OpenAIFileObject.optional().describe("The image attached in the chat. Send url, data or image, only one."),
  })
  .strict()
  .refine(oneMainImageSource, MAIN_IMAGE_ONE_SOURCE);

/** The check request without the chat attachment field: the body the REST
 * document describes, and the check_main_image arguments until P19-15. */
export const MainImageCheckRequestNoFiles = z
  .object({ ...mainImageSourceFields, channel: mainImageChannel })
  .strict()
  .refine(oneMainImageSource, MAIN_IMAGE_ONE_SOURCE);

export const MainImageCheckResponse = z.object({
  channel: z.string().describe("The marketplace whose rules were checked."),
  spec_id: z.string().describe("The verified channel specification used for this check."),
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
  rules: z.object({
    minLongSide: z.number(),
    minWidth: z.number().optional(),
    minHeight: z.number().optional(),
    fillMinPercent: z.number().nullable(),
    fillMaxPercent: z.number().nullable(),
    background: z.enum(["white", "white_or_transparent"]).optional(),
  }),
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

export const SmokeContextResponse = z.object({ workspaceId: z.uuid(), excluded: z.literal(true) });

export const ErrorResponse = z.object({
  error: z.string(),
  reason: z.string(),
  issues: z.array(z.string()).optional(),
  existingPackId: z.string().optional(),
  retryAfterSeconds: z.number().optional(),
});
export type ErrorBody = z.infer<typeof ErrorResponse>;

/** Schemas the OpenAPI document names under components.schemas. The request
 * bodies leave out the chat attachment fields (CHAT_FILE_FIELDS). */
export const COMPONENT_SCHEMAS = {
  CreatePackRequest: CreatePackRequestNoFiles,
  PackResponse,
  PackFilesResponse,
  MainImageCheckRequest: MainImageCheckRequestNoFiles,
  MainImageCheckResponse,
  ChannelsResponse,
  SmokeContextResponse,
  Error: ErrorResponse,
} as const;

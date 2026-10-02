/**
 * What the MCP tools return to ChatGPT and other assistants (docs/phases/
 * PHASE_19.md, "Outputs, structuredContent and outputSchema"): one "chat
 * view" schema per tool, from which each tool's outputSchema is generated
 * (P19-13) and against which every success result is validated. The views
 * carry only what the seller asked about (OpenAI O5 and O6: no session,
 * trace or request ids, no timestamps, no internal ids beyond the pack id),
 * so createdAt, productId, shot ids, the /api/v1 links and per shot RGB
 * backgrounds stay in the REST body (packOf) and never reach the chat.
 *
 * Wave 0 (P19-02) defines the shapes from the plan so every lane builds on
 * them: p19/tools writes the view builders (P19-14) and may refine fields,
 * p19/files fills preview_url and download_url (P19-17), p19/tools fills the
 * quote (P19-16), p19/auth returns ProfileChat from get_profile (P19-11),
 * and p19/site lists CHAT_VIEW_FIELDS in the privacy policy (P19-23).
 */

import { z } from "zod";
import { backgroundSwatches } from "@curvi/pipeline/seed";
import { jobErrorLineFor } from "@/lib/job-copy";
import { CHANNEL_ALIASES } from "@/lib/marketing-facts";
import { sceneStyleOptions } from "@/lib/output-options-form";
import type { EstimateLeftOut, JobFileView } from "@/lib/services/types";
import { MCP_COPY } from "./mcp-copy";
import { Channel, MainImageCheckResponse, PACK_STATUSES, ShotFidelity, type Pack } from "./schemas";

/** One delivered file of a finished pack. */
export const PackChatImage = z.object({
  name: z.string(),
  channel: z.string().nullable(),
  kind: z.enum(["image", "zip", "report"]),
  /** Whether the image passed its channel's size and background check;
   * null for zips, the report, or an image with no check. */
  passes_channel_rules: z.boolean().nullable(),
  fill_percent: z.number().nullable(),
  /** Measurements stored for this exact delivered file, never a different
   * channel variant or the shot aggregate. Null when it was not measured. */
  fidelity: ShotFidelity.nullable().optional(),
  /** A signed curvi.ai preview link (P19-17), or null for zips, the report,
   * or until the links ship. */
  preview_url: z.string().nullable(),
  /** A signed curvi.ai download link (P19-17), or null until the links ship. */
  download_url: z.string().nullable(),
});
export type PackChatImage = z.infer<typeof PackChatImage>;

/** create_pack and get_pack. */
export const PackChat = z.object({
  /** The handle get_pack needs. Listed in the privacy policy. */
  pack_id: z.string(),
  status: z.enum(PACK_STATUSES),
  finished: z.boolean(),
  /** The product title, which can come from AI analysis of the photo. Plain
   * text only. */
  product: z.string(),
  /** Channel spec ids. */
  channels: z.array(z.string()),
  credits: z.object({ held: z.number(), charged: z.number() }),
  progress: z.object({ done: z.number().int(), total: z.number().int() }),
  /** When the pack is finished, or when the caller asked for its files. */
  images: z.array(PackChatImage).optional(),
  /** How long the links in images work, in hours (decision 7: 24). */
  links_valid_hours: z.number().int().optional(),
  /** One plain sentence for the model to relay. */
  message: z.string(),
  /** Neutral text, or null. */
  error: z.string().nullable(),
  /** True when a retry returned the same pack. */
  replayed: z.boolean().optional(),
});
export type PackChat = z.infer<typeof PackChat>;

/** estimate_pack (P19-16). */
export const EstimateChat = z.object({
  credits_needed: z.number(),
  credits_available: z.number(),
  enough: z.boolean(),
  /** The channel spec ids the pack would make. */
  channels: z.array(z.string()),
  /** Requested channels the pack would leave out, and why, in plain words. */
  left_out: z.array(z.object({ channel: z.string(), reason: z.string() })),
  /** The signed quote create_pack requires (P19-16). */
  quote: z.string(),
  quote_valid_minutes: z.number().int(),
  message: z.string(),
});
export type EstimateChat = z.infer<typeof EstimateChat>;

/** One channel spec in list_channels, with neutral availability (no tier
 * names, no upgrade target). */
export const ChannelsChatChannel = z.object({
  id: z.string(),
  channel: z.string(),
  name: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  available: z.boolean(),
  /** "Not part of this workspace's current plan", "Coming soon", or null. */
  note: z.string().nullable(),
});

/** list_channels (P19-18): every value comes from the registry or the seed. */
export const ChannelsChat = z.object({
  channels: z.array(ChannelsChatChannel),
  /** Other names create_pack accepts for a channel, such as instagram for
   * meta. */
  aliases: z.array(z.object({ alias: z.string(), channel: z.string() })),
  bundles: z.array(z.object({ key: z.string(), label: z.string() })),
  backgrounds: z.array(z.object({ key: z.string(), label: z.string(), hex: z.string() })),
  scene_styles: z.array(z.object({ value: z.string(), label: z.string() })),
});
export type ChannelsChat = z.infer<typeof ChannelsChat>;

/** check_main_image: the existing check body, which holds no ids. */
export const MainImageCheckChat = MainImageCheckResponse;
export type MainImageCheckChat = z.infer<typeof MainImageCheckChat>;

/** get_profile (P19-11; OpenAI O1): a stable opaque id, the workspace name
 * and the member's email. */
export const ProfileChat = z
  .object({
    /** The member's stored profile_id: random, never derived from a secret,
     * never reassigned. Non empty and not blank, as OpenAI's profile tool
     * schema declares it (O1: minLength 1, pattern "\S"). */
    id: z.string().min(1).regex(/\S/),
    /** The workspace name. */
    name: z.string().optional(),
    email: z.string().optional(),
  })
  .strict();
export type ProfileChat = z.infer<typeof ProfileChat>;

/** Every chat view, by name. */
export const CHAT_VIEWS = {
  PackChat,
  EstimateChat,
  ChannelsChat,
  MainImageCheckChat,
  ProfileChat,
} as const;

function unwrapped(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable || current instanceof z.ZodDefault) {
    current = current.unwrap() as z.ZodType;
  }
  return current;
}

/** The dotted path of every field in a view, nested ones included, with []
 * for array items: credits.held, images[].preview_url. */
export function chatViewFields(schema: z.ZodType, prefix = ""): string[] {
  const inner = unwrapped(schema);
  if (inner instanceof z.ZodArray) {
    return chatViewFields(inner.element as z.ZodType, `${prefix}[]`);
  }
  if (!(inner instanceof z.ZodObject)) {
    return [];
  }
  return Object.entries(inner.shape as Record<string, z.ZodType>).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...chatViewFields(child, path)];
  });
}

/** Every field any chat view can send to an assistant, sorted, for the
 * privacy policy coverage test (P19-23). */
export const CHAT_VIEW_FIELDS: readonly string[] = [
  ...new Set(Object.values(CHAT_VIEWS).flatMap((view) => chatViewFields(view))),
].sort();

// Builders (P19-14). Each turns what the REST actions answer into the view
// an assistant gets; the REST bodies themselves never change.

/** A pack's delivered file with its links, as the link provider signs them. */
export interface PackFileLinks {
  preview_url: string | null;
  download_url: string | null;
}

/** Shots that count toward progress: every planned shot but the skipped. */
function countedShots(shots: Pack["shots"]): Pack["shots"] {
  return shots.filter((shot) => shot.status !== "skipped");
}

/** Images made so far out of the images planned. */
export function packProgressOf(shots: Pack["shots"]): { done: number; total: number } {
  const counted = countedShots(shots);
  return {
    done: counted.filter((shot) => shot.status === "done" || shot.status === "failed" || shot.status === "needs_review").length,
    total: counted.length,
  };
}

/**
 * The images part of a pack view: one entry per delivered file, with its
 * shot's channel check (found through the file's shotId) and the links the
 * provider signed. Zips and the report carry no check and no preview.
 */
export function packImagesOf(
  files: readonly JobFileView[],
  shots: Pack["shots"],
  links: ReadonlyMap<string, PackFileLinks>,
): PackChatImage[] {
  const shotById = new Map(shots.map((shot) => [shot.id, shot]));
  return files.map((file) => {
    const compliance = file.kind === "image" && file.shotId ? (shotById.get(file.shotId)?.compliance ?? null) : null;
    const link = links.get(file.id);
    return {
      name: file.name,
      channel: file.specId ?? file.channel,
      kind: file.kind,
      passes_channel_rules: compliance ? compliance.pass : null,
      fill_percent: compliance?.fillPct ?? null,
      fidelity: file.kind === "image" ? (file.fidelity ?? null) : null,
      preview_url: file.kind === "image" ? (link?.preview_url ?? null) : null,
      download_url: link?.download_url ?? null,
    };
  });
}

export interface PackChatOptions {
  /** create_pack made this pack now. */
  created?: boolean;
  /** create_pack answered a retry with the pack it already made. */
  replayed?: boolean;
  /** The delivered files, when the pack is finished or the caller asked. */
  images?: PackChatImage[];
  /** How long the links in images work, in minutes. */
  linksValidMinutes?: number | null;
}

/** The one plain sentence a pack view carries for the model to relay. */
function packMessageOf(pack: Pack, options: PackChatOptions, error: string | null): string {
  if (options.replayed) {
    return MCP_COPY.packReplayed;
  }
  if (options.created) {
    return `${MCP_COPY.packStarted(pack.creditsReserved)} ${MCP_COPY.packTakesMinutes}`;
  }
  const progress = packProgressOf(pack.shots);
  switch (pack.status) {
    case "queued":
      return MCP_COPY.packQueued;
    case "analyzing":
    case "planning":
      return MCP_COPY.packPlanning;
    case "generating":
    case "qc":
    case "packaging":
      return progress.total > 0 ? MCP_COPY.packWorking(progress.done, progress.total) : MCP_COPY.packPlanning;
    case "failed":
      return error ?? MCP_COPY.packFailed;
    case "canceled":
      return MCP_COPY.packCanceled;
    case "done": {
      const images = options.images?.filter((image) => image.kind === "image");
      const made = images ? images.length : pack.shots.filter((shot) => shot.status === "done").length;
      const passed = images
        ? images.filter((image) => image.passes_channel_rules !== false).length
        : pack.shots.filter((shot) => shot.status === "done" && shot.compliance?.pass !== false).length;
      return made > 0 ? MCP_COPY.packReady(passed, made) : MCP_COPY.packReadyNoImages;
    }
  }
}

/** create_pack and get_pack: the REST pack (packOf) without its ids beyond
 * the pack's, its timestamps or its links, plus the files when given. */
export function packChatOf(pack: Pack, options: PackChatOptions = {}): PackChat {
  const error = jobErrorLineFor(pack.error, "assistant");
  const hasLinks = options.images?.some((image) => image.preview_url !== null || image.download_url !== null) ?? false;
  const minutes = hasLinks ? (options.linksValidMinutes ?? null) : null;
  const message = packMessageOf(pack, options, error);
  return {
    pack_id: pack.id,
    status: pack.status,
    finished: pack.finished,
    product: pack.productTitle,
    channels: [...pack.channels],
    credits: { held: pack.creditsReserved, charged: pack.creditsCharged },
    progress: packProgressOf(pack.shots),
    ...(options.images ? { images: options.images } : {}),
    ...(minutes !== null && minutes % 60 === 0 ? { links_valid_hours: minutes / 60 } : {}),
    message: minutes !== null ? `${message} ${MCP_COPY.linksValid(minutes)}` : message,
    error,
    ...(options.replayed ? { replayed: true } : {}),
  };
}

/** estimate_pack's answer, with the quote create_pack needs. */
export function estimateChatOf(args: {
  creditsNeeded: number;
  creditsAvailable: number;
  channels: readonly string[];
  leftOut: readonly EstimateLeftOut[];
  quote: string;
  quoteValidMinutes: number;
}): EstimateChat {
  const enough = args.creditsAvailable >= args.creditsNeeded;
  return {
    credits_needed: args.creditsNeeded,
    credits_available: args.creditsAvailable,
    enough,
    channels: [...args.channels],
    left_out: args.leftOut.map((entry) => ({
      channel: entry.specId,
      reason: entry.reason === "coming_soon" ? MCP_COPY.channelComingSoon : MCP_COPY.channelNotMade,
    })),
    quote: args.quote,
    quote_valid_minutes: args.quoteValidMinutes,
    message: enough
      ? MCP_COPY.estimateReady(args.creditsNeeded, args.creditsAvailable)
      : MCP_COPY.estimateShort(args.creditsNeeded, args.creditsAvailable),
  };
}

/**
 * list_channels for an assistant (P19-18): the REST channel list with plain
 * availability instead of a tier to buy, and every value create_pack takes
 * for the background, the scene style and the bundle, from the seed, so the
 * model maps "white" or "kitchen" to a value without guessing. While the
 * output options switch is off (`optionsOn` false), create_pack refuses
 * every background and scene choice, so none is offered.
 */
export function channelsChatOf(
  rest: {
    channels: ReadonlyArray<z.infer<typeof Channel>>;
    bundles: ReadonlyArray<{ key: string; label: string }>;
  },
  options: { optionsOn?: boolean } = {},
): ChannelsChat {
  const optionsOn = options.optionsOn ?? true;
  return {
    channels: rest.channels.map((entry) => ({
      id: entry.id,
      channel: entry.channel,
      name: entry.name,
      width: entry.width,
      height: entry.height,
      available: entry.availability === "available",
      note:
        entry.availability === "coming_soon"
          ? MCP_COPY.channelComingSoon
          : entry.availability === "upgrade_required"
            ? MCP_COPY.channelNotInPlan
            : null,
    })),
    aliases: CHANNEL_ALIASES.map((entry) => ({ alias: entry.alias, channel: entry.family })),
    bundles: rest.bundles.map((bundle) => ({ key: bundle.key, label: bundle.label })),
    backgrounds: optionsOn
      ? Object.entries(backgroundSwatches).map(([key, swatch]) => ({ key, label: swatch.label, hex: swatch.hex }))
      : [],
    scene_styles: optionsOn ? sceneStyleOptions().map((style) => ({ value: style.value, label: style.label })) : [],
  };
}

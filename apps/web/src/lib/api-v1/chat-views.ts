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
import { MainImageCheckResponse, PACK_STATUSES } from "./schemas";

/** One delivered file of a finished pack. */
export const PackChatImage = z.object({
  name: z.string(),
  channel: z.string().nullable(),
  kind: z.enum(["image", "zip", "report"]),
  /** Whether the image passed its channel's size and background check;
   * null for zips, the report, or an image with no check. */
  passes_channel_rules: z.boolean().nullable(),
  fill_percent: z.number().nullable(),
  /** A signed curvi.ai preview link (P19-17), or null for zips, the report,
   * or until the links ship. */
  preview_url: z.string().nullable(),
  /** A signed curvi.ai download link (P19-17), or null until the links ship. */
  download_url: z.string().nullable(),
});

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
     * never reassigned. */
    id: z.string().min(1),
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

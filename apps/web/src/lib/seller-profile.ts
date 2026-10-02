/**
 * The first run answers (docs/phases/PHASE_18.md P18-20): "What do you
 * sell?" from the seeded sellerCategories and "Where do you sell?" from the
 * seeded channelChoices, both optional, saved on workspaces.seller_profile
 * by the server. The profile preselects the channels of the first pack on
 * /app/new, and the funnel digest and lifecycle email segment by it.
 *
 * Pure and client safe: the welcome questions, the save route and the new
 * pack page all use it.
 */

import { channelChoices, isSellerCategoryKey, sellerCategories } from "@curvi/pipeline/seed";

/** What a seller answered; either part may be empty. */
export interface SellerAnswer {
  category: string | null;
  /** channelChoices values, in seed order, no repeats. */
  channels: string[];
}

/** The stored profile as the app reads it. */
export interface SellerProfile extends SellerAnswer {
  answeredAt: string | null;
}

/** The jsonb written to workspaces.seller_profile (an object, at most 1 KB). */
export interface SellerProfileJson {
  category?: string;
  channels?: string[];
  answeredAt: string;
}

const CHANNEL_VALUES: readonly string[] = channelChoices.map((choice) => choice.value);

/** The seeded choices, for the welcome questions. */
export function sellerCategoryChoices(): readonly { key: string; label: string }[] {
  return sellerCategories;
}

export function sellerChannelChoices(): readonly { value: string; label: string }[] {
  return channelChoices.map(({ value, label }) => ({ value, label }));
}

function cleanChannels(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > CHANNEL_VALUES.length * 2) {
    return null;
  }
  const picked = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string" || !CHANNEL_VALUES.includes(value)) {
      return null;
    }
    picked.add(value);
  }
  return CHANNEL_VALUES.filter((value) => picked.has(value));
}

/**
 * A request body's answer, or null when it is malformed: category a seeded
 * key or null, channels a list of seeded channel values. An unknown value
 * refuses the whole answer rather than saving part of it.
 */
export function cleanSellerAnswer(raw: unknown): SellerAnswer | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const body = raw as Record<string, unknown>;
  let category: string | null = null;
  if (body.category !== undefined && body.category !== null) {
    if (!isSellerCategoryKey(body.category)) {
      return null;
    }
    category = body.category;
  }
  const channels = cleanChannels(body.channels ?? []);
  if (!channels) {
    return null;
  }
  return { category, channels };
}

/** True when the answer says something (a category or a channel). */
export function answerSaysSomething(answer: SellerAnswer): boolean {
  return answer.category !== null || answer.channels.length > 0;
}

/** The jsonb to store for an answer. */
export function sellerProfileJson(answer: SellerAnswer, now: Date): SellerProfileJson {
  return {
    ...(answer.category ? { category: answer.category } : {}),
    ...(answer.channels.length > 0 ? { channels: answer.channels } : {}),
    answeredAt: now.toISOString(),
  };
}

/** A stored profile read defensively: values that are not seeded any more
 * are dropped. Null when nothing was saved. */
export function readSellerProfile(raw: unknown): SellerProfile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const stored = raw as Record<string, unknown>;
  const category = isSellerCategoryKey(stored.category) ? stored.category : null;
  const channels = Array.isArray(stored.channels)
    ? CHANNEL_VALUES.filter((value) => (stored.channels as unknown[]).includes(value))
    : [];
  const answeredAt = typeof stored.answeredAt === "string" ? stored.answeredAt : null;
  return { category, channels, answeredAt };
}

/**
 * The channel specs the first pack starts with for a profile: each chosen
 * channel's seeded specs (channelChoices[].specs), in seed order. Empty
 * when the profile names no channel, so the form keeps its default pick.
 */
export function profileChannelSpecs(profile: Pick<SellerAnswer, "channels"> | null | undefined): string[] {
  if (!profile || profile.channels.length === 0) {
    return [];
  }
  return channelChoices.filter((choice) => profile.channels.includes(choice.value)).flatMap((choice) => [...choice.specs]);
}

/** The channelChoices value a channel spec belongs to, for the channel
 * pages' signup links (amazon.main is amazon); null for a spec no choice
 * lists (social formats). */
export function channelChoiceForSpec(specId: string): string | null {
  return channelChoices.find((choice) => choice.specs.includes(specId))?.value ?? null;
}

/**
 * Seller inputs the planner uses beyond the photos themselves: the role each
 * photo plays (which angle it shows), the SKU, what is in the box and the
 * comparison facts the seller can back up. Pure and sharp free, so the web
 * form, the service layer and the worker share one definition.
 *
 * Box contents and comparison facts are printed on template images exactly
 * as the seller wrote them (never rewritten by a model), so the limits here
 * match the Shot schema's callout limits: at most 5 lines of 40 characters.
 * A longer line is refused at the form and the API, never cut, because a
 * truncated fact would print a wrong claim on a charged image.
 */
import type { ProductProfile } from "./schemas";

/** The role a photo plays in the pack, picked by the seller per photo. */
export const ANGLE_ROLES = ["front", "back", "side", "detail", "in_the_box", "scale"] as const;
export type AngleRole = (typeof ANGLE_ROLES)[number];

export function isAngleRole(value: unknown): value is AngleRole {
  return typeof value === "string" && (ANGLE_ROLES as readonly string[]).includes(value);
}

/** Most lines of box contents or comparison facts one image can carry. */
export const MAX_SELLER_LINES = 5;
/** Longest line, the Shot schema's callout cap. */
export const MAX_SELLER_LINE_CHARS = 40;
/** Longest SKU accepted. The SKU names delivered files ("{sku}.MAIN.jpg"),
 * so it is kept short and to file name safe characters (SKU_PATTERN). */
export const MAX_SKU_CHARS = 40;

/** Letters, digits, dot, underscore and hyphen, not starting with a dot. */
export const SKU_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

type ProfileAngle = ProductProfile["photographedAngles"][number];

/**
 * The analyzer's angle name for a seller role, or null when the role is not
 * an angle the analyzer tracks. The in the box photo is the analyzer's
 * "packaging" angle, which is where the planner looks for the in_the_box
 * shot's source photo. A scale photo (the product in a hand or beside a
 * common object) is not "in_use": for apparel that angle means on model
 * photos, which a scale photo is not.
 */
export function profileAngleFor(role: AngleRole): ProfileAngle | null {
  switch (role) {
    case "front":
    case "back":
    case "side":
    case "detail":
      return role;
    case "in_the_box":
      return "packaging";
    case "scale":
      return null;
  }
}

/** The key the planner's mediaIdsByAngle uses for a role. */
export function planAngleKey(role: AngleRole): string {
  return profileAngleFor(role) ?? role;
}

/**
 * Media id per planner angle from the seller's roles, first photo per role
 * wins (callers pass this request's uploads first, then stored photos).
 */
export function mediaIdsByAngle(
  images: ReadonlyArray<{ mediaId: string; angle?: AngleRole | null }>,
): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {};
  for (const image of images) {
    if (!image.angle) {
      continue;
    }
    const key = planAngleKey(image.angle);
    out[key] ??= image.mediaId;
  }
  return out;
}

/**
 * The analyzer's profile with the seller's photo roles merged in. A role the
 * seller set is a photographed angle, whatever the analyzer saw, so the
 * planner plans a white alternate image from that exact photo and no longer
 * lists the angle as missing. Angles the analyzer found stay.
 */
export function withSellerAngles(profile: ProductProfile, roles: ReadonlyArray<AngleRole | null | undefined>): ProductProfile {
  const declared = new Set<ProfileAngle>();
  for (const role of roles) {
    const angle = role ? profileAngleFor(role) : null;
    if (angle) {
      declared.add(angle);
    }
  }
  if (declared.size === 0) {
    return profile;
  }
  const photographed = [...profile.photographedAngles];
  for (const angle of declared) {
    if (!photographed.includes(angle)) {
      photographed.push(angle);
    }
  }
  return {
    ...profile,
    photographedAngles: photographed,
    missingAnglesNeeded: profile.missingAnglesNeeded.filter((m) => !declared.has(m as ProfileAngle)),
  };
}

/**
 * Seller lines ready to print: trimmed, single spaced, empty lines dropped,
 * duplicates dropped, at most MAX_SELLER_LINES. A line over the length cap
 * is dropped whole rather than cut.
 */
export function printableSellerLines(lines: ReadonlyArray<string> | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of lines ?? []) {
    const line = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
    if (line.length === 0 || line.length > MAX_SELLER_LINE_CHARS || out.includes(line)) {
      continue;
    }
    out.push(line);
    if (out.length >= MAX_SELLER_LINES) {
      break;
    }
  }
  return out;
}

/** Splits a textarea value into seller lines, one per line of text. */
export function sellerLinesFromText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
}

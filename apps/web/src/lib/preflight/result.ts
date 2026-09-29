/**
 * Turns the runner side preflight (trigger/src/preflight.ts) into the
 * verdict the form shows and the row upload_preflights keeps. Pure, so the
 * rules are unit tested without a database or a provider:
 *
 * - intake could not answer (or the photo could not be loaded): unavailable,
 *   and the pack may still start, since it checks again when it runs;
 * - a moderation flag, a screenshot, or no sellable product: blocked, with
 *   the specific fix;
 * - 2 to 6 pieces and at most one featured by the rules: choose, with the
 *   rules' pick preselected (a product in several parts is never split by a
 *   tap, so it stays ready);
 * - otherwise ready.
 */

import { listSpecs } from "@curvi/specs";
import { sizeRequirement } from "@curvi/pipeline/size-gate";
import type { UploadPreflightRun } from "@curvi/trigger/preflight";
import { CUTOUT_UNAVAILABLE_NOTICE, PREFLIGHT_UNAVAILABLE_NOTICE, problemFor } from "./copy";
import type { PreflightBox, PreflightItemView, PreflightSizeNeed, PreflightStatus, PreflightView } from "./types";

/** The chooser shows this many products at most, like the vision picker. */
export const CHOOSER_MIN_ITEMS = 2;
export const CHOOSER_MAX_ITEMS = 6;

/** A stored item: the thumbnail's object key instead of a signed url. */
export interface StoredPreflightItem extends Omit<PreflightItemView, "thumbUrl"> {
  thumbKey: string | null;
}

/** What upload_preflights.result holds. */
export interface StoredPreflight extends Omit<PreflightView, "key" | "items"> {
  items: StoredPreflightItem[];
  /** The product box the inventory found, for the P1 crop fit (jsonb, no
   * migration). The worker reads it when the seller tapped no target. */
  productBox?: PreflightBox | null;
}

/** What every image channel spec needs from a photo, from the registry. */
export function sizeNeeds(): PreflightSizeNeed[] {
  return listSpecs().flatMap((spec) => {
    const need = sizeRequirement(spec);
    return need ? [{ specId: need.specId, measure: need.measure, needs: need.needs }] : [];
  });
}

function longSideOf(box: PreflightBox, photo: { width: number; height: number } | null): number | null {
  return photo ? Math.round(Math.max(box.width * photo.width, box.height * photo.height)) : null;
}

export function storedPreflightOf(run: UploadPreflightRun, thumbKeys: ReadonlyArray<string | null> = []): StoredPreflight {
  const base: StoredPreflight = {
    status: "unavailable",
    found: null,
    problem: null,
    notice: null,
    items: [],
    preselect: null,
    photo: run.photo,
    productLongSide: null,
    sizes: sizeNeeds(),
  };
  if (run.missing || !run.intake) {
    return { ...base, notice: PREFLIGHT_UNAVAILABLE_NOTICE };
  }
  const image = run.intake.image;
  const products = image.products ?? [];
  if (run.moderation.length > 0) {
    return { ...base, status: "blocked", problem: problemFor("prohibited", { reasons: run.moderation }) };
  }
  if (image.screenshot === true) {
    return { ...base, status: "blocked", problem: problemFor("screenshot") };
  }
  if (!image.sellableProduct) {
    return { ...base, status: "blocked", problem: problemFor("no_product") };
  }

  const items: StoredPreflightItem[] = run.items.map((item, i) => ({
    number: item.number,
    label: item.label,
    box: item.box,
    thumbKey: thumbKeys[i] ?? null,
    longSide: longSideOf(item.box, run.photo),
  }));
  const featured = run.items.filter((item) => item.featured);
  const single = products.length === 1 ? products[0] : null;
  let status: PreflightStatus = "ready";
  let preselect: number | null = null;
  if (items.length >= CHOOSER_MIN_ITEMS && items.length <= CHOOSER_MAX_ITEMS && featured.length <= 1) {
    status = "choose";
    preselect = featured[0]?.number ?? null;
  }
  const found = featured.length > 0 ? [...new Set(featured.map((f) => f.label))].join(" and ") : (single?.label ?? null);
  const productItem = featured.length === 1 ? featured[0] : items.length === 1 ? run.items[0] : null;
  const productLongSide = productItem
    ? longSideOf(productItem.box, run.photo)
    : single
      ? longSideOf(single.box, run.photo)
      : null;
  return {
    ...base,
    status,
    found,
    notice: run.cutout === "unavailable" ? CUTOUT_UNAVAILABLE_NOTICE : null,
    items: status === "choose" ? items : [],
    preselect,
    productLongSide,
    ...(run.productBox ? { productBox: run.productBox } : {}),
  };
}

/** The stored verdict as the form sees it, with each thumbnail signed. */
export async function preflightViewOf(
  key: string,
  stored: StoredPreflight,
  sign: (thumbKey: string) => Promise<string | null>,
): Promise<PreflightView> {
  const items = await Promise.all(
    stored.items.map(async ({ thumbKey, ...item }) => ({
      ...item,
      thumbUrl: thumbKey ? await sign(thumbKey).catch(() => null) : null,
    })),
  );
  return { ...stored, key, items };
}

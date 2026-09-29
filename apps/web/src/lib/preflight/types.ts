/**
 * The preflight at upload as the new pack form sees it (docs/phases/
 * PHASE_14.md workstream 4 and item 3.2). Plain data, safe for client
 * components: no server imports here.
 */

/** A box normalized to 0..1 of the upright photo (source_media.target_box). */
export interface PreflightBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Why a photo cannot start a pack. */
export type PreflightProblemCode = "prohibited" | "no_product" | "screenshot" | "invalid_upload";

export interface PreflightProblem {
  code: PreflightProblemCode;
  /** What is wrong, in plain words. */
  title: string;
  /** What to do about it. */
  fix: string;
  /** Concrete photo tips, when a better photo is the fix. */
  tips?: string[];
}

/** One product found in the photo, for the chooser. */
export interface PreflightItemView {
  number: number;
  label: string;
  box: PreflightBox;
  /** A signed or inline url of the item's thumbnail; null when none. */
  thumbUrl: string | null;
  /** The product's long side in the photo's pixels. */
  longSide: number | null;
}

/** What one channel spec needs from the photo (@curvi/pipeline size gate). */
export interface PreflightSizeNeed {
  specId: string;
  /** "product": the product region is measured; "photo": the whole photo. */
  measure: "product" | "photo";
  needs: number;
}

export type PreflightStatus = "ready" | "choose" | "blocked" | "unavailable";

export interface PreflightView {
  key: string;
  status: PreflightStatus;
  /** What was found, for "Found: silver watch." Null when unknown. */
  found: string | null;
  /** Set when status is blocked. */
  problem: PreflightProblem | null;
  /** Something the seller should know that does not stop the pack. */
  notice: string | null;
  /** The products to choose from when status is choose (2 to 6). */
  items: PreflightItemView[];
  /** The item the note decided, preselected in the chooser. */
  preselect: number | null;
  /** The upright photo's size. */
  photo: { width: number; height: number } | null;
  /** The product's long side when one product was found or decided. */
  productLongSide: number | null;
  /** What every image channel spec needs from the photo. */
  sizes: PreflightSizeNeed[];
  /** Intake saw text, borders, watermarks or stickers added on top of the
   * photo (intake version 5). A kept photo so flagged is left out of the
   * channels that refuse them. Absent on older rows: a clean photo. */
  addedOverlays?: boolean;
  /** True for the simulated demo mode answer. */
  demo?: boolean;
}

export type PreflightOutcome =
  | { ok: true; preflight: PreflightView }
  | {
      ok: false;
      reason: "forbidden" | "foreign_key" | "invalid_upload" | "unavailable";
      message: string;
    };

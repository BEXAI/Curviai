/**
 * Shapes of the store image audit (docs/phases/PHASE_18.md P18-18) shared by
 * the route and the page. Client safe: no node imports here.
 */

import type { CheckRow } from "@/lib/tools/main-image-analysis";
import type { StoreAuditErrorReason } from "@/components/marketing/search-copy";

/** Why one product's first image was not checked. */
export type StoreAuditSkipReason =
  | "invalid_url"
  | "blocked_host"
  | "not_image"
  | "too_large"
  | "timeout"
  | "unreachable"
  | "deadline";

export type StoreAuditProductResult =
  | { status: "checked"; pass: boolean; width: number; height: number; rows: CheckRow[] }
  | { status: "no_image" }
  | { status: "not_checked"; reason: StoreAuditSkipReason };

export interface StoreAuditProduct {
  /** The product's name as the store lists it, cut short. */
  title: string;
  /** The product page on the store, https. */
  url: string;
  /** How many images the store lists for the product. */
  imageCount: number;
  result: StoreAuditProductResult;
}

export interface StoreAuditSummary {
  /** Products read from the store's list (at most the seeded maximum). */
  listed: number;
  /** Products whose first image was checked. */
  checked: number;
  /** Checked products whose first image fails at least one rule. */
  failing: number;
  /** Products with fewer images than thinImageCount. */
  thin: number;
  /** Products with an image that could not be checked. */
  notChecked: number;
  thinImageCount: number;
}

export interface StoreAuditReport {
  /** The store's host, for the heading. */
  store: string;
  channel: { key: string; name: string };
  summary: StoreAuditSummary;
  products: StoreAuditProduct[];
}

export type StoreAuditOutcome =
  | { ok: true; report: StoreAuditReport }
  | { ok: false; reason: StoreAuditErrorReason; message: string };

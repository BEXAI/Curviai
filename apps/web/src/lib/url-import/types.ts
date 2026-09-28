/**
 * Shapes shared by the product import routes and the new pack form. Client
 * safe: no node imports here.
 */

export type ImportPlatform = "shopify" | "amazon" | "page";

export interface ImportedImage {
  /** Absolute https URL of the photo on the store's own CDN. */
  url: string;
  width?: number;
  height?: number;
  alt?: string;
}

export interface ImportedProduct {
  platform: ImportPlatform;
  /** The product link the seller pasted, normalised. */
  sourceUrl: string;
  title: string;
  /** Plain text description, line breaks kept. */
  description: string;
  /** Bullet points or feature lines, when the page has them. */
  bullets: string[];
  images: ImportedImage[];
  /** True when the page could only be read in part (for example Amazon
   * asked for a captcha); `notice` then says what to do. */
  partial: boolean;
  notice?: string;
}

/** Longest product name the new pack form and the jobs route accept. */
export const IMPORT_TITLE_MAX = 120;
/** Longest seller notes the new pack form and the jobs route accept. */
export const IMPORT_NOTES_MAX = 2000;

/**
 * Seller notes for the new pack form from an imported product: the bullet
 * points one per line when there are any, else the description, capped to
 * what the jobs route accepts.
 */
export function sellerNotesFrom(product: Pick<ImportedProduct, "bullets" | "description">): string {
  const text = product.bullets.length > 0 ? product.bullets.join("\n") : product.description;
  if (text.length <= IMPORT_NOTES_MAX) {
    return text;
  }
  const cut = text.slice(0, IMPORT_NOTES_MAX);
  const lineEnd = cut.lastIndexOf("\n");
  return (lineEnd > IMPORT_NOTES_MAX * 0.5 ? cut.slice(0, lineEnd) : cut).trim();
}

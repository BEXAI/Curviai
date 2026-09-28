/**
 * Browser side calls for the product link import. Each returns a plain
 * outcome the new pack form can show; none throws.
 */

import type { ImportedProduct } from "./types";

export type ProductImportOutcome = { ok: true; product: ImportedProduct } | { ok: false; message: string };

export type PhotoImportOutcome =
  | { phase: "uploaded"; name: string; key: string; sha256: string; kind: "image" }
  | { phase: "notice"; message: string }
  | { phase: "error"; message: string };

const OFFLINE = "We could not reach Curvi. Check your connection and try again.";

export async function requestProductImport(url: string): Promise<ProductImportOutcome> {
  try {
    const response = await fetch("/api/imports/product", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = (await response.json().catch(() => ({}))) as { product?: ImportedProduct; error?: string };
    if (!response.ok || !data.product) {
      return { ok: false, message: data.error ?? "We could not read that link. Try again, or add a photo instead." };
    }
    return { ok: true, product: data.product };
  } catch {
    return { ok: false, message: OFFLINE };
  }
}

/** Copies one listed photo into this workspace's uploads. `name` is what
 * the form shows once it is in. */
export async function requestPhotoImport(url: string, name: string): Promise<PhotoImportOutcome> {
  try {
    const response = await fetch("/api/imports/photo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      key?: string;
      sha256?: string;
      notice?: string;
      error?: string;
    };
    if (response.status === 503 && data.notice) {
      return { phase: "notice", message: data.notice };
    }
    if (!response.ok || !data.key || !data.sha256) {
      return { phase: "error", message: data.error ?? "We could not import that photo. Try again." };
    }
    return { phase: "uploaded", name, key: data.key, sha256: data.sha256, kind: "image" };
  } catch {
    return { phase: "error", message: OFFLINE };
  }
}

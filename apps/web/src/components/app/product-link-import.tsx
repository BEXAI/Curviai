"use client";

import { useState, type FormEvent } from "react";
import { Button, Input, Label, cn } from "@curvi/ui";
import { track } from "@/lib/track";
import { requestProductImport } from "@/lib/url-import/client";
import type { ImportedImage, ImportedProduct } from "@/lib/url-import/types";

/** Photos shown to pick from. */
const SHOWN_PHOTOS = 8;

type ImportState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded"; product: ImportedProduct }
  | { phase: "error"; message: string };

interface ProductLinkImportProps {
  /** Called with the product once the link is read, to prefill the form. */
  onProduct: (product: ImportedProduct) => void;
  /** Called when the seller picks one of the listed photos. */
  onPickPhoto: (image: ImportedImage, index: number) => void;
  /** True while a photo is uploading or importing. */
  busy: boolean;
}

/**
 * "Start from your product link": paste a Shopify or Amazon product page,
 * get the name and notes filled in, then pick the photo to build from.
 */
export function ProductLinkImport({ onProduct, onPickPhoto, busy }: ProductLinkImportProps) {
  const [link, setLink] = useState("");
  const [state, setState] = useState<ImportState>({ phase: "idle" });
  const [picked, setPicked] = useState<number | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!link.trim() || state.phase === "loading") {
      return;
    }
    setState({ phase: "loading" });
    setPicked(null);
    const outcome = await requestProductImport(link.trim());
    if (!outcome.ok) {
      setState({ phase: "error", message: outcome.message });
      return;
    }
    setState({ phase: "loaded", product: outcome.product });
    onProduct(outcome.product);
    track("product_link_imported", {
      platform: outcome.product.platform,
      photo_count: outcome.product.images.length,
      partial: outcome.product.partial,
    });
  }

  const product = state.phase === "loaded" ? state.product : null;
  const photos = product?.images.slice(0, SHOWN_PHOTOS) ?? [];

  return (
    <div className="mt-3 rounded-xl border border-ink-200 bg-white p-4" data-testid="url-import">
      <form onSubmit={(event) => void submit(event)}>
        <Label htmlFor="product-link">Start from your product link</Label>
        <p className="mt-1 text-xs text-ink-500">
          Paste a product page from your Shopify store or from Amazon. We fill in the name and notes and show its
          photos so you can pick one.
        </p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <Input
            id="product-link"
            // Text, not url, so a link pasted without https:// still submits;
            // the server reads it as https.
            type="text"
            inputMode="url"
            autoComplete="off"
            value={link}
            maxLength={2048}
            onChange={(event) => setLink(event.target.value)}
            placeholder="https://yourstore.com/products/ceramic-mug"
          />
          <Button type="submit" variant="outline" disabled={state.phase === "loading" || !link.trim()}>
            {state.phase === "loading" ? "Reading the page" : "Import"}
          </Button>
        </div>
      </form>

      <div aria-live="polite">
        {state.phase === "error" ? (
          <p className="mt-3 text-sm text-red-600" role="alert" data-testid="url-import-error">
            {state.message}
          </p>
        ) : null}
        {product ? (
          <div className="mt-3" data-testid="url-import-result">
            <p className="text-sm text-ink-800">
              {product.title ? <>Imported {product.title}.</> : <>Imported the page.</>}
            </p>
            {product.notice ? (
              <p className="mt-1 text-sm text-amber-700" data-testid="url-import-notice">
                {product.notice}
              </p>
            ) : null}
            {photos.length > 0 ? (
              <>
                <p className="mt-2 text-xs text-ink-500">
                  Pick the photo to build from. A clear front view on a plain background works best.
                </p>
                <ul className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-8">
                  {photos.map((image, index) => (
                    <li key={image.url}>
                      <button
                        type="button"
                        disabled={busy}
                        aria-pressed={picked === index}
                        aria-label={`Use photo ${index + 1}${image.alt ? `: ${image.alt}` : ""}`}
                        onClick={() => {
                          setPicked(index);
                          onPickPhoto(image, index);
                        }}
                        className={cn(
                          "block aspect-square w-full overflow-hidden rounded-lg border bg-ink-50",
                          picked === index ? "border-ink-900 ring-2 ring-ink-900" : "border-ink-200 hover:border-ink-400",
                        )}
                        data-testid="url-import-photo"
                      >
                        {/* Shown straight from the store's CDN; the server
                            only downloads the one photo that is picked. */}
                        <img
                          src={image.url}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          className="h-full w-full object-contain"
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : product.partial ? null : (
              <p className="mt-1 text-sm text-amber-700">
                That page has no photos we can use. Add one with Choose a file.
              </p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

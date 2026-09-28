"use client";

import { useCallback, useMemo, useState } from "react";
import { filenameFor, type ChannelSpec } from "@curvi/specs";
import { Button, Card, CardContent, buttonVariants, cn } from "@curvi/ui";
import { EmailGate } from "./email-gate";
import { imageSpecs, specDisplayName, specSlug } from "./spec-slug";
import { resizerGateCopy } from "./tool-copy";

interface ResizedResult {
  specId: string;
  filename: string;
  width: number;
  height: number;
  dataUrl: string;
}

function targetDims(spec: ChannelSpec): { width: number; height: number } {
  const width = spec.width ?? spec.minWidth ?? spec.minLongSide ?? 1600;
  const height = spec.height ?? spec.minHeight ?? spec.minLongSide ?? width;
  return { width, height };
}

function filenameForSpec(spec: ChannelSpec): string {
  if (spec.naming) {
    try {
      return filenameFor(spec, { sku: "SKU1", seoSlug: "product", n: 1 });
    } catch {
      // fall through to the slug name
    }
  }
  return `${specSlug(spec.id)}.jpg`;
}

/**
 * Client side resize with white padding to each selected channel spec.
 * Downloads use the spec filename convention where one exists. Previews are
 * free; the downloads sit behind the email gate.
 */
export function MarketplaceResizer() {
  const specs = useMemo(() => imageSpecs(), []);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(["amazon.main", "shopify.product", "meta.feed_1x1"]),
  );
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [fileLabel, setFileLabel] = useState<string | null>(null);
  const [results, setResults] = useState<ResizedResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const onFile = useCallback((file: File | undefined) => {
    if (!file) return;
    setError(null);
    setResults([]);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setImage(img);
      setFileLabel(`${file.name}, ${img.naturalWidth} by ${img.naturalHeight} px`);
    };
    img.onerror = () => {
      setError("That file could not be read as an image. Try a jpg or png.");
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }, []);

  const generate = useCallback(() => {
    if (!image) return;
    setBusy(true);
    setError(null);
    try {
      const out: ResizedResult[] = [];
      for (const spec of specs) {
        if (!selected.has(spec.id)) continue;
        const { width, height } = targetDims(spec);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new Error("Canvas is not available in this browser");
        }
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
        const dw = Math.round(image.naturalWidth * scale);
        const dh = Math.round(image.naturalHeight * scale);
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(image, Math.round((width - dw) / 2), Math.round((height - dh) / 2), dw, dh);
        out.push({
          specId: spec.id,
          filename: filenameForSpec(spec),
          width,
          height,
          dataUrl: canvas.toDataURL("image/jpeg", 0.92),
        });
      }
      setResults(out);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Resize failed");
    } finally {
      setBusy(false);
    }
  }, [image, selected, specs]);

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-5 pt-6">
          <label className="block cursor-pointer rounded-xl border-2 border-dashed border-ink-200 bg-ink-50 p-8 text-center transition-colors hover:border-accent-500">
            <span className="block text-sm font-medium text-ink-900">Choose a product photo</span>
            <span className="mt-1 block text-sm text-ink-500">
              {fileLabel ?? "Runs in your browser. Nothing is uploaded."}
            </span>
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              aria-label="Choose an image to resize"
              onChange={(event) => onFile(event.target.files?.[0])}
            />
            <span className={buttonVariants({ className: "mt-4" })}>
              Select image
            </span>
          </label>

          <fieldset>
            <legend className="text-sm font-semibold text-ink-900">Pick your channels</legend>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {specs.map((spec) => {
                const dims = targetDims(spec);
                const checked = selected.has(spec.id);
                return (
                  <label
                    key={spec.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm transition-colors",
                      checked ? "border-accent-500 bg-accent-50" : "border-ink-100 hover:bg-ink-50",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(spec.id)}
                      className="h-4 w-4 accent-accent-500"
                    />
                    <span>
                      <span className="block font-medium text-ink-900">{specDisplayName(spec.id)}</span>
                      <span className="block text-xs text-ink-500">
                        {dims.width} by {dims.height} px
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <Button variant="secondary" size="lg" disabled={!image || selected.size === 0 || busy} onClick={generate}>
            {busy ? "Resizing" : `Resize for ${selected.size} channel${selected.size === 1 ? "" : "s"}`}
          </Button>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </CardContent>
      </Card>

      {results.length > 0 ? (
        <Card>
          <CardContent className="pt-6">
            <h2 className="text-lg font-semibold text-ink-950">Your resized files</h2>
            <p className="mt-1 text-sm text-ink-500">
              White padded to fit, exported as jpg, named the way each channel expects. Replace SKU1
              and product with your own SKU and slug after download.
            </p>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {results.map((result) => (
                <li key={result.specId} className="rounded-lg border border-ink-100 p-3">
                  <img
                    src={result.dataUrl}
                    alt={`Resized for ${specDisplayName(result.specId)}`}
                    className="aspect-square w-full rounded border border-ink-100 object-contain"
                  />
                  <p className="mt-2 truncate text-xs font-medium text-ink-900">{result.filename}</p>
                  <p className="text-xs text-ink-500">
                    {result.width} by {result.height} px
                  </p>
                </li>
              ))}
            </ul>
            <div className="mt-6">
              <EmailGate source="marketplace-resizer" title={resizerGateCopy.title} body={resizerGateCopy.body}>
                <ul data-testid="resizer-downloads" className="flex flex-wrap gap-2">
                  {results.map((result) => (
                    <li key={result.specId}>
                      <a
                        href={result.dataUrl}
                        download={result.filename}
                        className="inline-flex h-8 items-center justify-center rounded-lg border border-ink-200 px-3 text-xs font-medium text-ink-900 hover:bg-ink-50"
                      >
                        Download {result.filename}
                      </a>
                    </li>
                  ))}
                </ul>
              </EmailGate>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

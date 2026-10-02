"use client";

import { useState, useTransition } from "react";
import { HEX } from "@curvi/pipeline/output-options";
import { Button, Card, CardContent, Input, Label, Select, cn } from "@curvi/ui";
import { brandKitCopy } from "@/components/marketing/brand-kit-copy";
import { BrandPaletteSuggestion } from "@/components/app/brand-palette-suggestion";
import type { BrandPaletteOutcome } from "@/lib/brand/types";
import type { BrandKitView, SaveResult } from "@/lib/services/types";
import { uploadTypeForFile } from "@/lib/upload-validation";

interface SelectOption {
  value: string;
  label: string;
}

interface BrandKitFormProps {
  initial: BrandKitView;
  presetOptions: SelectOption[];
  /** Template fonts from the seed catalog; the empty value is the default. */
  fontOptions: SelectOption[];
  save: (kit: BrandKitView) => Promise<SaveResult>;
  /** Reads colors from the uploaded logo (PHASE_16 workstream 7). Returns a
   * suggestion only; the kit changes when the seller confirms and saves. */
  suggestPalette?: (logoKey: string) => Promise<BrandPaletteOutcome>;
  /** The most colors a kit holds (seed MAX_BRAND_COLORS). */
  maxColors?: number;
}

const MIN_COLOR_SLOTS = 3;

/** The logo picker's accept list, checked again for dropped files. */
const LOGO_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
const LOGO_TYPE_COPY = "This file type is not supported. Use a PNG, JPEG or WEBP logo.";

export function BrandKitForm({
  initial,
  presetOptions,
  fontOptions,
  save,
  suggestPalette,
  maxColors = MIN_COLOR_SLOTS,
}: BrandKitFormProps) {
  const [kit, setKit] = useState<BrandKitView>(initial);
  const [result, setResult] = useState<SaveResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [palette, setPalette] = useState<
    | { phase: "idle" }
    | { phase: "reading" }
    | { phase: "done"; outcome: BrandPaletteOutcome }
    | { phase: "applied" }
  >({ phase: "idle" });
  // One empty slot after the filled ones, at least MIN_COLOR_SLOTS, at most maxColors.
  const colorSlots = Math.min(
    Math.max(maxColors, MIN_COLOR_SLOTS),
    Math.max(MIN_COLOR_SLOTS, kit.colors.filter((c) => c.length > 0).length + 1),
  );

  async function readPalette() {
    if (!suggestPalette || !kit.logoKey) {
      return;
    }
    setPalette({ phase: "reading" });
    try {
      setPalette({ phase: "done", outcome: await suggestPalette(kit.logoKey) });
    } catch {
      setPalette({
        phase: "done",
        outcome: { ok: false, reason: "unavailable", notice: brandKitCopy.paletteUnavailable },
      });
    }
  }
  const [logoState, setLogoState] = useState<
    | { phase: "idle" }
    | { phase: "uploading" }
    | { phase: "uploaded"; previewUrl: string }
    | { phase: "error"; message: string }
  >({ phase: "idle" });

  async function handleLogoFile(file: File) {
    const type = uploadTypeForFile(file, { allowVideo: false, allowedImageTypes: LOGO_CONTENT_TYPES });
    if (!type.ok) {
      setLogoState({ phase: "error", message: LOGO_TYPE_COPY });
      return;
    }
    setLogoState({ phase: "uploading" });
    try {
      const response = await fetch("/api/uploads/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "image", contentType: type.contentType, bytes: file.size }),
      });
      const data = (await response.json()) as { url?: string; key?: string; error?: string; notice?: string };
      if (!response.ok || !data.url || !data.key) {
        setLogoState({ phase: "error", message: data.error ?? data.notice ?? "The upload could not be signed." });
        return;
      }
      const put = await fetch(data.url, { method: "PUT", headers: { "Content-Type": type.contentType }, body: file });
      if (!put.ok) {
        setLogoState({ phase: "error", message: "The upload failed. Try again." });
        return;
      }
      setKit((current) => ({ ...current, logoKey: data.key, hasLogo: true }));
      setLogoState({ phase: "uploaded", previewUrl: URL.createObjectURL(file) });
      setPalette({ phase: "idle" });
    } catch {
      setLogoState({ phase: "error", message: "The upload failed. Check your connection and try again." });
    }
  }

  function setColor(index: number, value: string) {
    setKit((current) => {
      const colors = [...current.colors];
      colors[index] = value;
      return { ...current, colors };
    });
  }

  const invalidColors = kit.colors.filter((c) => c.length > 0 && !HEX.test(c));

  function submit() {
    setResult(null);
    startTransition(async () => {
      const outcome = await save({ ...kit, colors: kit.colors.filter((c) => HEX.test(c)) });
      setResult(outcome);
    });
  }

  return (
    <Card>
      <CardContent className="space-y-6 p-6">
        <div>
          <Label htmlFor="kit-name">Kit name</Label>
          <Input
            id="kit-name"
            value={kit.name}
            onChange={(event) => setKit({ ...kit, name: event.target.value })}
            className="mt-1 max-w-sm"
          />
        </div>

        <div>
          <Label>Brand colors</Label>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            {Array.from({ length: colorSlots }, (_, index) => index).map((index) => (
              <div key={index} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-8 w-8 shrink-0 rounded-lg border border-ink-200"
                  style={{
                    backgroundColor: HEX.test(kit.colors[index] ?? "") ? kit.colors[index] : "#ffffff",
                  }}
                />
                <Input
                  aria-label={`Brand color ${index + 1}`}
                  placeholder="#1D2433"
                  value={kit.colors[index] ?? ""}
                  onChange={(event) => setColor(index, event.target.value)}
                />
              </div>
            ))}
          </div>
          {invalidColors.length > 0 ? (
            <p className="mt-2 text-xs text-amber-700">Colors must look like #1D2433. Others are skipped on save.</p>
          ) : (
            <p className="mt-2 text-xs text-ink-400">{brandKitCopy.colorsHint}</p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="font-heading">Heading font</Label>
            <Select
              id="font-heading"
              value={kit.fonts.heading}
              onChange={(event) => setKit({ ...kit, fonts: { ...kit.fonts, heading: event.target.value } })}
              className="mt-1"
            >
              {fontOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="font-body">Body font</Label>
            <Select
              id="font-body"
              value={kit.fonts.body}
              onChange={(event) => setKit({ ...kit, fonts: { ...kit.fonts, body: event.target.value } })}
              className="mt-1"
            >
              {fontOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          <p className="text-xs text-ink-400 sm:col-span-2">{brandKitCopy.fontsHint}</p>
        </div>

        <div>
          <Label>Logo</Label>
          <div className="mt-2 flex max-w-sm items-center gap-4">
            {logoState.phase === "uploaded" ? (
              <img
                src={logoState.previewUrl}
                alt="Brand logo preview"
                className="h-20 w-20 rounded-xl border border-ink-950/10 bg-white object-contain p-1"
              />
            ) : kit.logoUrl ? (
              <img
                src={kit.logoUrl}
                alt="Brand logo"
                className="h-20 w-20 rounded-xl border border-ink-950/10 bg-white object-contain p-1"
              />
            ) : (
              <div className="flex h-20 w-20 items-center justify-center rounded-xl border-2 border-dashed border-ink-200 bg-ink-50">
                <span className="text-xs text-ink-400">No logo</span>
              </div>
            )}
            <div>
              <label className="inline-block cursor-pointer">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      void handleLogoFile(file);
                    }
                    event.target.value = "";
                  }}
                />
                <span className="inline-flex h-9 items-center rounded-lg border border-ink-950/15 bg-white px-3 text-sm font-medium text-ink-900 transition-colors hover:bg-ink-50">
                  {logoState.phase === "uploading" ? "Uploading" : kit.hasLogo ? "Replace logo" : "Upload logo"}
                </span>
              </label>
              {logoState.phase === "error" ? (
                <p className="mt-2 text-xs text-red-600">{logoState.message}</p>
              ) : (
                <p className="mt-2 text-xs text-ink-400">{brandKitCopy.logoHint}</p>
              )}
            </div>
          </div>
          {suggestPalette && kit.logoKey ? (
            <div className="mt-4" data-testid="brand-palette">
              {palette.phase === "done" && palette.outcome.ok ? (
                <BrandPaletteSuggestion
                  suggestion={palette.outcome.suggestion}
                  maxColors={Math.max(maxColors, MIN_COLOR_SLOTS)}
                  onUse={(colors) => {
                    setKit((current) => ({ ...current, colors }));
                    setResult(null);
                    setPalette({ phase: "applied" });
                  }}
                  onDismiss={() => setPalette({ phase: "idle" })}
                />
              ) : (
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void readPalette()}
                    disabled={palette.phase === "reading" || logoState.phase === "uploading"}
                  >
                    {palette.phase === "reading" ? brandKitCopy.paletteReading : brandKitCopy.paletteButton}
                  </Button>
                  {palette.phase === "done" && !palette.outcome.ok ? (
                    <p className="mt-2 text-xs text-amber-700" data-testid="brand-palette-notice">
                      {palette.outcome.notice}
                    </p>
                  ) : null}
                  {palette.phase === "applied" ? (
                    <p className="mt-2 text-xs text-emerald-700" data-testid="brand-palette-notice">
                      {brandKitCopy.paletteApplied}
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}
        </div>

        <div>
          <Label htmlFor="style-preset">Style preset</Label>
          <Select
            id="style-preset"
            value={kit.stylePreset}
            onChange={(event) => setKit({ ...kit, stylePreset: event.target.value })}
            className="mt-1 max-w-sm"
          >
            {presetOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-ink-400">{brandKitCopy.presetHint}</p>
        </div>

        <div>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving" : "Save brand kit"}
          </Button>
          {result ? (
            <p className={cn("mt-3 text-sm", result.ok ? "text-emerald-700" : "text-amber-700")} data-testid="brand-save-result">
              {result.notice}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

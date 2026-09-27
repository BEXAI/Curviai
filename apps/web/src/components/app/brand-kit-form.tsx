"use client";

import { useState, useTransition } from "react";
import { Button, Card, CardContent, Input, Label, Select, cn } from "@curvi/ui";
import type { BrandKitView, SaveResult } from "@/lib/services/types";

interface BrandKitFormProps {
  initial: BrandKitView;
  presetKeys: string[];
  save: (kit: BrandKitView) => Promise<SaveResult>;
}

const HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/;

export function BrandKitForm({ initial, presetKeys, save }: BrandKitFormProps) {
  const [kit, setKit] = useState<BrandKitView>(initial);
  const [result, setResult] = useState<SaveResult | null>(null);
  const [pending, startTransition] = useTransition();

  function setColor(index: number, value: string) {
    setKit((current) => {
      const colors = [...current.colors];
      colors[index] = value;
      return { ...current, colors };
    });
  }

  const invalidColors = kit.colors.filter((c) => c.length > 0 && !HEX_PATTERN.test(c));

  function submit() {
    setResult(null);
    startTransition(async () => {
      const outcome = await save({ ...kit, colors: kit.colors.filter((c) => HEX_PATTERN.test(c)) });
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
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-8 w-8 shrink-0 rounded-lg border border-ink-200"
                  style={{
                    backgroundColor: HEX_PATTERN.test(kit.colors[index] ?? "") ? kit.colors[index] : "#ffffff",
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
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="font-heading">Heading font</Label>
            <Input
              id="font-heading"
              value={kit.fonts.heading}
              onChange={(event) => setKit({ ...kit, fonts: { ...kit.fonts, heading: event.target.value } })}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="font-body">Body font</Label>
            <Input
              id="font-body"
              value={kit.fonts.body}
              onChange={(event) => setKit({ ...kit, fonts: { ...kit.fonts, body: event.target.value } })}
              className="mt-1"
            />
          </div>
        </div>

        <div>
          <Label>Logo</Label>
          <div className="mt-2 flex h-24 max-w-sm items-center justify-center rounded-xl border-2 border-dashed border-ink-200 bg-ink-50">
            <p className="text-xs text-ink-400">
              {kit.hasLogo ? "Logo on file." : "Logo upload arrives with the asset editor."}
            </p>
          </div>
        </div>

        <div>
          <Label htmlFor="style-preset">Style preset</Label>
          <Select
            id="style-preset"
            value={kit.stylePreset}
            onChange={(event) => setKit({ ...kit, stylePreset: event.target.value })}
            className="mt-1 max-w-sm"
          >
            {presetKeys.map((key) => (
              <option key={key} value={key}>
                {key.replaceAll("_", " ")}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-ink-400">Sets the default look for lifestyle scenes.</p>
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

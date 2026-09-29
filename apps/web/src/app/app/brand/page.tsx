import type { Metadata } from "next";
import { AUTO_STYLE_PRESET, DEFAULT_TEMPLATE_FONT, presets, templateFonts } from "@curvi/pipeline/seed";
import { BrandKitForm } from "@/components/app/brand-kit-form";
import { brandKitCopy } from "@/components/marketing/brand-kit-copy";
import { getServices } from "@/lib/services";
import { MAX_BRAND_COLORS } from "@/lib/validation/brand-kit";
import { saveBrandKitAction, suggestBrandPaletteAction } from "./actions";

export const metadata: Metadata = { title: "Brand kit" };
export const dynamic = "force-dynamic";

export default async function BrandPage() {
  const services = getServices();
  const workspace = await services.ensureWorkspace();
  if (!workspace) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold text-ink-950">Sign in to edit your brand kit</h1>
      </div>
    );
  }
  const kit = await services.getBrandKit(workspace.id);
  // The empty value is the default font; the catalog comes from the seed.
  const fontOptions = [
    { value: "", label: brandKitCopy.defaultFontLabel },
    ...Object.entries(templateFonts)
      .filter(([key]) => key !== DEFAULT_TEMPLATE_FONT)
      .map(([key, entry]) => ({ value: key, label: entry.label })),
  ];
  const presetOptions = [
    { value: AUTO_STYLE_PRESET, label: brandKitCopy.autoPresetLabel },
    ...Object.keys(presets).map((key) => ({ value: key, label: key.replaceAll("_", " ") })),
  ];

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold tracking-tight text-ink-950">Brand kit</h1>
      <p data-testid="brand-kit-intro" className="mt-1 text-sm text-ink-500">
        {brandKitCopy.intro}
      </p>
      <div className="mt-8">
        <BrandKitForm
          initial={kit}
          presetOptions={presetOptions}
          fontOptions={fontOptions}
          save={saveBrandKitAction}
          suggestPalette={suggestBrandPaletteAction}
          maxColors={MAX_BRAND_COLORS}
        />
      </div>
    </div>
  );
}

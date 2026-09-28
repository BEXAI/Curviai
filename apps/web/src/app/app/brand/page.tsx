import type { Metadata } from "next";
import { presets } from "@curvi/pipeline/seed";
import { BrandKitForm } from "@/components/app/brand-kit-form";
import { brandKitCopy } from "@/components/marketing/brand-kit-copy";
import { getServices } from "@/lib/services";
import { saveBrandKitAction } from "./actions";

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

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold tracking-tight text-ink-950">Brand kit</h1>
      <p data-testid="brand-kit-intro" className="mt-1 text-sm text-ink-500">
        {brandKitCopy.intro}
      </p>
      <div className="mt-8">
        <BrandKitForm initial={kit} presetKeys={Object.keys(presets)} save={saveBrandKitAction} />
      </div>
    </div>
  );
}

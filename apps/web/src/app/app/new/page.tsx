import type { Metadata } from "next";
import { NewPackForm } from "@/components/app/new-pack-form";
import { tierKeyOf } from "@/lib/entitlements";
import { getServices } from "@/lib/services";
import { newPackChannelOptions } from "./channel-options";

export const metadata: Metadata = { title: "New pack" };
export const dynamic = "force-dynamic";

export default async function NewPackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const services = getServices();
  const workspace = await services.ensureWorkspace();
  if (!workspace) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold text-ink-950">Sign in to start a pack</h1>
        <p className="mt-3 text-ink-600">Your workspace appears here after you sign in.</p>
      </div>
    );
  }
  const params = await searchParams;
  const requestedProduct = typeof params.product === "string" ? params.product : null;
  const products = await services.listProducts(workspace.id);
  const tier = tierKeyOf(workspace.plan);
  // Channels whose feature is not live, or not in this plan, are shown but
  // cannot be picked, matching what createJob accepts.
  const channels = newPackChannelOptions(tier);

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-ink-950">New pack</h1>
      <p className="mt-1 text-sm text-ink-500">
        One photo in. A compliant pack out. Pick channels and watch it render live.
      </p>
      <div className="mt-8">
        <NewPackForm
          products={products.map((p) => ({
            id: p.id,
            title: p.title,
            mode: p.mode,
            sku: p.sku,
            boxContents: p.boxContents,
            comparisonFacts: p.comparisonFacts,
          }))}
          channels={channels}
          tier={tier}
          creditBalance={workspace.creditBalance}
          initialProductId={requestedProduct}
        />
      </div>
    </div>
  );
}

import type { Metadata } from "next";
import { listSpecs, isMarketplaceSpec } from "@curvi/specs";
import type { TierKey } from "@curvi/pipeline/seed";
import { tiers } from "@curvi/pipeline/seed";
import { NewPackForm } from "@/components/app/new-pack-form";
import { getServices } from "@/lib/services";

export const metadata: Metadata = { title: "New pack" };
export const dynamic = "force-dynamic";

export default async function NewPackPage() {
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
  const products = await services.listProducts(workspace.id);
  const channels = listSpecs().map((spec) => ({
    id: spec.id,
    marketplace: isMarketplaceSpec(spec.id),
  }));
  const tier: TierKey = tiers.find((t) => t.key === workspace.plan)?.key ?? "free";

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-ink-950">New pack</h1>
      <p className="mt-1 text-sm text-ink-500">
        One photo in. A compliant pack out. Pick channels and watch it render live.
      </p>
      <div className="mt-8">
        <NewPackForm
          products={products.map((p) => ({ id: p.id, title: p.title, mode: p.mode }))}
          channels={channels}
          tier={tier}
          creditBalance={workspace.creditBalance}
        />
      </div>
    </div>
  );
}

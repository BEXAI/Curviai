import type { Metadata } from "next";
import { NewPackForm } from "@/components/app/new-pack-form";
import { LowBalanceNudge } from "@/components/app/paywall";
import { canManageBilling } from "@/lib/billing/access";
import { lowBalanceCopy, type PaywallContext } from "@/lib/billing/paywall";
import { tierKeyOf } from "@/lib/entitlements";
import { isStripeConfigured } from "@/lib/env";
import { preflightCopy, providerPreflight } from "@/lib/provider-preflight";
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
  const paywall: PaywallContext = {
    plan: workspace.plan,
    creditBalance: workspace.creditBalance,
    stripeLive: isStripeConfigured(),
    canBill: canManageBilling(workspace.role),
  };
  const nudge = lowBalanceCopy(paywall);
  // Preflight (Phase 14 1.5): say so before submit when an image service is
  // down; with the cutout service down no pack can deliver, so Create pack
  // is disabled.
  const preflight = await providerPreflight();
  const preflightNotice = preflightCopy(preflight);

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-ink-950">New pack</h1>
      <p className="mt-1 text-sm text-ink-500">
        One photo in. A compliant pack out. Pick channels and watch it render live.
      </p>
      {preflightNotice ? (
        <div
          role="status"
          data-testid="preflight-banner"
          data-verdict={preflight}
          className={
            preflight === "packs_paused"
              ? "mt-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
              : "mt-6 rounded-lg border border-ink-200 bg-ink-50 px-4 py-3 text-sm text-ink-700"
          }
        >
          {preflightNotice}
        </div>
      ) : null}
      {nudge ? (
        <div className="mt-6">
          <LowBalanceNudge copy={nudge} moment="new_pack" />
        </div>
      ) : null}
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
          paywall={paywall}
          initialProductId={requestedProduct}
          packsPaused={preflight === "packs_paused"}
        />
      </div>
    </div>
  );
}

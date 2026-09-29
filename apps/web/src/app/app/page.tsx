import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardContent, CardHeader, CardTitle, buttonVariants } from "@curvi/ui";
import { LowBalanceNudge } from "@/components/app/paywall";
import { StatusChip } from "@/components/app/status-chip";
import { canManageBilling } from "@/lib/billing/access";
import { lowBalanceCopy } from "@/lib/billing/paywall";
import { isStripeConfigured } from "@/lib/env";
import {
  freeCredits,
  joinList,
  liveChannelNames,
  tierDisplayName,
  typicalPackCredits,
} from "@/lib/marketing-facts";
import { packCreditsLine } from "@/lib/product-library";
import { getServices } from "@/lib/services";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

/** "12 credits", "1 credit", "2.5 credits". */
function formatBalance(credits: number): string {
  return `${credits.toLocaleString("en-US")} ${credits === 1 ? "credit" : "credits"}`;
}

export default async function DashboardPage() {
  const services = getServices();
  const workspace = await services.ensureWorkspace();
  if (!workspace) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold text-ink-950">Sign in to open your workspace</h1>
        <p className="mt-3 text-ink-600">
          Log in and your workspace loads here. New accounts get a workspace and {freeCredits()} free credits
          the moment they confirm their email.
        </p>
        <Link href="/login?next=/app" className={buttonVariants({ variant: "secondary", className: "mt-6" })}>
          Log in
        </Link>
      </div>
    );
  }

  const [products, jobs] = await Promise.all([
    services.listProducts(workspace.id),
    services.listRecentJobs(workspace.id, 8),
  ]);
  const firstSession = jobs.length === 0;
  const nudge = lowBalanceCopy({
    plan: workspace.plan,
    creditBalance: workspace.creditBalance,
    stripeLive: isStripeConfigured(),
    canBill: canManageBilling(workspace.role),
  });

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-950">{workspace.name}</h1>
          <p className="mt-1 text-sm text-ink-500">Everything your products need, one photo at a time.</p>
        </div>
        <Link
          href="/app/new"
          className={buttonVariants({ variant: "secondary" })}
        >
          New pack
        </Link>
      </div>

      <LowBalanceNudge copy={nudge} moment="dashboard" />

      <div className="grid gap-6 md:grid-cols-3">
        <Card data-testid="credit-balance">
          <CardHeader>
            <CardTitle>Credits</CardTitle>
          </CardHeader>
          <CardContent>
            {workspace.creditBalance < 0 ? (
              // Only a plan change debit takes the balance below zero (refunds
              // and disputes stop at zero), so say that instead of showing a
              // bare negative number. /app/billing carries the same notice.
              <div data-testid="negative-balance">
                <p className="text-2xl font-bold tracking-tight text-amber-900">
                  {formatBalance(-workspace.creditBalance)} below zero
                </p>
                <p className="mt-1 text-sm text-ink-600">
                  A move to a smaller plan returned money for time on the bigger plan, so the credits that time paid
                  for were taken back, including some you had already used. New packs start again once a top up or
                  your next renewal brings the balance back up.
                </p>
              </div>
            ) : (
              <p className="text-4xl font-bold tracking-tight text-ink-950">
                {workspace.creditBalance.toLocaleString("en-US")}
              </p>
            )}
            <p className="mt-1 text-sm text-ink-500">
              On the {tierDisplayName(workspace.plan)} plan. A default listing pack of still images uses about{" "}
              {typicalPackCredits()} credits.
            </p>
            <Link href="/app/billing" className="mt-3 inline-block text-sm font-medium text-accent-600 hover:text-accent-700">
              Manage billing
            </Link>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Recent packs</CardTitle>
          </CardHeader>
          <CardContent>
            {firstSession ? (
              <p className="text-sm text-ink-500">No packs yet. Your first one takes a few minutes.</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {jobs.map((job) => (
                  <li key={job.id} className="flex items-center justify-between gap-3 py-3">
                    <div>
                      <Link href={`/app/jobs/${job.id}`} className="text-sm font-medium text-ink-900 hover:text-accent-600">
                        {job.productTitle}
                      </Link>
                      <p className="text-xs text-ink-400">
                        {packCreditsLine(job)}
                      </p>
                    </div>
                    <StatusChip status={job.status} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {firstSession ? (
        <Card data-testid="first-session" className="border-accent-200 bg-accent-50">
          <CardContent className="p-8 text-center">
            <h2 className="text-xl font-semibold text-ink-950">Get your first pack</h2>
            <p className="mx-auto mt-2 max-w-xl text-sm text-ink-600">
              Upload one product photo. You get a compliant main image, lifestyle shots and a compliance report
              on every file, sized for {joinList(liveChannelNames())}.
            </p>
            <ol className="mx-auto mt-4 max-w-md space-y-1 text-left text-sm text-ink-700">
              <li>1. Add one photo of your product.</li>
              <li>2. Pick your channels.</li>
              <li>3. Watch the pack render live.</li>
            </ol>
            <Link
              href="/app/new"
              className={buttonVariants({ size: "lg", className: "mt-6" })}
            >
              Start your first pack
            </Link>
          </CardContent>
        </Card>
      ) : null}

      <section>
        <h2 className="text-lg font-semibold text-ink-950">Products</h2>
        {products.length === 0 ? (
          <p className="mt-3 text-sm text-ink-500">No products yet. Your first pack creates one.</p>
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="products-grid">
            {products.map((product) => (
              <Card key={product.id}>
                <CardContent className="p-5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium text-ink-900">{product.title}</p>
                    {product.mode === "concept" ? <Badge variant="warning">Concept</Badge> : null}
                  </div>
                  <p className="mt-1 text-xs text-ink-400">{product.category.replaceAll("_", " ")}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

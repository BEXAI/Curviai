import { isOperator } from "@/lib/ops";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { BrowserErrors } from "@/components/app/browser-errors";
import { AppNav } from "@/components/app/app-nav";
import { PastDueBanner } from "@/components/app/billing-actions";
import { PackReadyNotice } from "@/components/app/pack-ready-notice";
import { HeaderCreditBalance } from "@/components/app/paywall";
import { SiteFooter } from "@/components/marketing/site-footer";
import { Wordmark } from "@/components/marketing/site-header";
import { loadPastDueNotice } from "@/lib/billing/account";
import { lowBalanceThreshold } from "@/lib/billing/paywall";
import { getServices, isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { getSessionUser } from "@/lib/supabase/server";
import { recordTermsAcceptanceSafely } from "@/lib/trust/terms";

export const metadata: Metadata = {
  title: { template: "%s | Curvi", default: "App | Curvi" },
  robots: { index: false, follow: false },
};

/** The header balance. Best effort: a failed read hides the balance and the
 * page still loads, since every page reads the workspace again itself. */
async function loadHeaderBalance(signedIn: boolean): Promise<number | null> {
  if (!signedIn) {
    return null;
  }
  try {
    return (await getServices().getCurrentWorkspace())?.creditBalance ?? null;
  } catch (error) {
    console.error(JSON.stringify({ msg: "app header: balance read failed", error: String(error) }));
    return null;
  }
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  const demo = !isDbMode();
  const user = demo ? null : await getSessionUser();
  if (user) {
    // The server side terms record, when the signup callback did not write
    // one (lib/trust/terms.ts). Best effort; never blocks the page.
    await recordTermsAcceptanceSafely(getDb(), { userId: user.id, source: "first_app_visit", headers: await headers() });
  }
  const [pastDue, creditBalance] = await Promise.all([
    user ? loadPastDueNotice(user.id) : null,
    loadHeaderBalance(demo || Boolean(user)),
  ]);
  return (
    <div className="theme-dark flex min-h-screen flex-col bg-night text-ink-900">
      <a href="#app-content" className="sr-only z-50 rounded-lg bg-white px-4 py-3 text-black focus:not-sr-only focus:fixed focus:left-3 focus:top-3">Skip to content</a>
      <BrowserErrors />
      <header className="sticky top-0 z-40 border-b border-ink-100 bg-night/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-6 py-3">
          <Link href="/" aria-label="Curvi home page">
            <Wordmark />
          </Link>
          <div className="flex items-center gap-2">

            {creditBalance !== null ? (
              <HeaderCreditBalance creditBalance={creditBalance} lowThreshold={lowBalanceThreshold()} />
            ) : null}
            <AppNav signedIn={Boolean(user)} operator={isOperator(user)} />
            {user ? (
              <div className="hidden items-center gap-3 border-l md:flex border-ink-100 pl-4">
                <span className="hidden max-w-48 truncate text-xs text-ink-500 xl:block" title={user.email ?? ""}>
                  {user.email}
                </span>
                <form action="/auth/signout" method="post">
                  <button
                    type="submit"
                    className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-50 hover:text-ink-950"
                  >
                    Sign out
                  </button>
                </form>
              </div>
            ) : null}
          </div>
        </div>
      </header>
      {demo ? (
        <div className="border-b border-accent-200 bg-accent-50">
          <p className="mx-auto max-w-6xl px-6 py-2 text-sm text-ink-700" data-testid="demo-banner">
            Demo mode. No database is configured, so data is sample data and packs are simulated. Jobs you start
            here reset when the server restarts.
          </p>
        </div>
      ) : null}
      {pastDue ? <PastDueBanner message={pastDue} /> : null}
      <main id="app-content" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
      <SiteFooter />
      {demo || user ? <PackReadyNotice /> : null}
    </div>
  );
}

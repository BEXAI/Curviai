import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppNav } from "@/components/app/app-nav";
import { PastDueBanner } from "@/components/app/billing-actions";
import { HeaderCreditBalance } from "@/components/app/paywall";
import { Wordmark } from "@/components/marketing/site-header";
import { loadPastDueNotice } from "@/lib/billing/account";
import { lowBalanceThreshold } from "@/lib/billing/paywall";
import { getServices, isDbMode } from "@/lib/services";
import { getSessionUser } from "@/lib/supabase/server";

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
  const [pastDue, creditBalance] = await Promise.all([
    user ? loadPastDueNotice(user.id) : null,
    loadHeaderBalance(demo || Boolean(user)),
  ]);
  return (
    <div className="min-h-screen bg-ink-50">
      <header className="border-b border-ink-100 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <Link href="/app" aria-label="Curvi app home">
            <Wordmark />
          </Link>
          <div className="flex flex-wrap items-center gap-4">
            <AppNav />
            {creditBalance !== null ? (
              <HeaderCreditBalance creditBalance={creditBalance} lowThreshold={lowBalanceThreshold()} />
            ) : null}
            {user ? (
              <div className="flex items-center gap-3 border-l border-ink-100 pl-4">
                <span className="hidden max-w-48 truncate text-xs text-ink-500 sm:block" title={user.email ?? ""}>
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
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}

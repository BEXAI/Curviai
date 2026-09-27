import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppNav } from "@/components/app/app-nav";
import { Wordmark } from "@/components/marketing/site-header";
import { isDbMode } from "@/lib/services";

export const metadata: Metadata = {
  title: { template: "%s | Curvi", default: "App | Curvi" },
};

export default function AppLayout({ children }: { children: ReactNode }) {
  const demo = !isDbMode();
  return (
    <div className="min-h-screen bg-ink-50">
      <header className="border-b border-ink-100 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <Link href="/app" aria-label="Curvi app home">
            <Wordmark />
          </Link>
          <AppNav />
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
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}

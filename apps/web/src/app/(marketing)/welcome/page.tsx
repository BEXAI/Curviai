import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@curvi/ui";
import { siteUrl } from "@/lib/env";
import { DEFAULT_NEXT_PATH, safeNextPath } from "@/lib/safe-next";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Welcome to Curvi",
  description: "Your Curvi account is verified.",
  path: "/welcome",
  noIndex: true,
});

/**
 * Where a new seller lands after clicking the email verification link: the
 * auth callback has already exchanged the code and set the session, then
 * sends a freshly verified account here (lib/verification.ts) with the page
 * it was heading to as next. next always goes through safeNextPath, so the
 * button never leaves the site. Opening the page directly still reads well.
 */
export default async function WelcomePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const destination = safeNextPath(next ?? null, siteUrl());
  const toApp = destination === DEFAULT_NEXT_PATH;
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg flex-col justify-center px-6 py-16 text-center" data-testid="welcome">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-brand">Email verified</p>
      <h1 className="mt-4 font-display text-4xl font-bold tracking-tight text-white">Congratulations on joining Curvi</h1>
      <p className="mt-4 text-lg text-white/90">Your account is now verified.</p>
      <p className="mt-2 text-white/70">
        Upload one product photo and get images made to each channel&apos;s rules. Your product is never redrawn.
      </p>
      <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Link
          href={toApp ? "/app/new" : destination}
          className={buttonVariants({ variant: "secondary", size: "lg" })}
          data-testid="welcome-continue"
        >
          {toApp ? "Make your first pack" : "Continue"}
        </Link>
        <Link href="/app" className={buttonVariants({ variant: "ghost", size: "lg", className: "text-white/85 hover:bg-white/10 hover:text-white" })}>
          Go to your dashboard
        </Link>
      </div>
    </div>
  );
}

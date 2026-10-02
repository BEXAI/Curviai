import { SignupGrantNotice } from "@/components/app/signup-grant-notice";
import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@curvi/ui";
import { WelcomeQuestions } from "@/components/marketing/welcome-questions";
import { siteUrl } from "@/lib/env";
import { DEFAULT_NEXT_PATH, safeNextPath } from "@/lib/safe-next";
import { sellerCategoryChoices, sellerChannelChoices } from "@/lib/seller-profile";
import { getServices } from "@/lib/services";
import { pageMetadata } from "@/lib/seo";
import { profileHintFrom } from "@/lib/signup-callback";

export const metadata: Metadata = pageMetadata({
  title: "Welcome to Curvi",
  description: "Your Curvi account is verified.",
  path: "/welcome",
  noIndex: true,
});

type WelcomeSearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * True when the signed in member should see the first run questions
 * (P18-20): a workspace with no saved answers, and a seat that can answer
 * for it (not a client seat). Signed out, or any failure, shows the page
 * without them.
 */
async function asksQuestions(): Promise<boolean> {
  try {
    const services = getServices();
    const workspace = await services.getCurrentWorkspace();
    if (!workspace || workspace.role === "client") {
      return false;
    }
    return (await services.getSellerProfile(workspace.id)) === null;
  } catch {
    return false;
  }
}

/**
 * Where a new seller lands after clicking the email verification link, or
 * after a first Google sign in: the auth callback has already exchanged the
 * code and set the session, then sends a freshly verified account here
 * (lib/verification.ts) with the page it was heading to as next. next always
 * goes through safeNextPath, so the button never leaves the site. Opening
 * the page directly still reads well. A new workspace also gets two optional
 * questions (P18-20), preselected from ?category= and ?channel= when a
 * category or channel page sent the visitor.
 */
export default async function WelcomePage({ searchParams }: { searchParams: Promise<WelcomeSearchParams> }) {
  const params = await searchParams;
  const destination = safeNextPath(first(params.next), siteUrl());
  const toApp = destination === DEFAULT_NEXT_PATH;
  const continueHref = toApp ? "/app/new" : destination;
  // A claimed free preview (P18-12) continues to /app/new on its product.
  const continueLabel = toApp || destination.startsWith("/app/new") ? "Make your first pack" : "Continue";
  const ask = await asksQuestions();
  const hint = profileHintFrom({ get: (key: string) => first(params[key]) });
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg flex-col justify-center px-6 py-16 text-center" data-testid="welcome">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-brand">Email verified</p>
      <h1 className="mt-4 font-display text-4xl font-bold tracking-tight text-white">Congratulations on joining Curvi</h1>
      <p className="mt-4 text-lg text-white/90">Your account is now verified.</p>
      <p className="mt-2 text-white/70">
        Upload one product photo and get images made to each channel&apos;s rules. Your product is never redrawn.
      </p>
      {await SignupGrantNotice()}
      {ask ? (
        <WelcomeQuestions
          continueHref={continueHref}
          continueLabel={continueLabel}
          categories={sellerCategoryChoices()}
          channels={sellerChannelChoices()}
          initialCategory={hint.category ?? null}
          initialChannels={hint.channel ? [hint.channel] : []}
        />
      ) : (
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href={continueHref}
            className={buttonVariants({ variant: "secondary", size: "lg" })}
            data-testid="welcome-continue"
          >
            {continueLabel}
          </Link>
          <Link
            href="/app"
            className={buttonVariants({ variant: "ghost", size: "lg", className: "text-white/85 hover:bg-white/10 hover:text-white" })}
          >
            Go to your dashboard
          </Link>
        </div>
      )}
    </div>
  );
}

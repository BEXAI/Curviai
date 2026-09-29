"use client";

import Link from "next/link";
import { buttonVariants } from "@curvi/ui";
import { MobileMenu, type MobileMenuLink } from "./mobile-menu";
import { useSignedIn } from "./signed-in";

/**
 * The right side of the marketing header. Signed out visitors get Log in
 * and Start free (the same label as the home hero and the pricing cards); a
 * visitor who is already signed in gets one Open app link instead of being
 * sent through signup again.
 */
export function HeaderActionsView({ signedIn, links }: { signedIn: boolean; links: MobileMenuLink[] }) {
  if (signedIn) {
    return (
      <div className="flex items-center gap-3">
        <Link href="/app" className={buttonVariants({ variant: "secondary" })}>
          Open app
        </Link>
        <MobileMenu links={[...links, { href: "/app", label: "Open app" }]} />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3">
      <Link href="/login" className="hidden text-sm font-medium text-ink-300 transition-colors hover:text-white sm:block">
        Log in
      </Link>
      <Link href="/signup" className={buttonVariants({ variant: "secondary" })}>
        Start free
      </Link>
      <MobileMenu links={[...links, { href: "/login", label: "Log in" }]} />
    </div>
  );
}

export function HeaderActions({ links }: { links: MobileMenuLink[] }) {
  const signedIn = useSignedIn();
  return <HeaderActionsView signedIn={signedIn} links={links} />;
}

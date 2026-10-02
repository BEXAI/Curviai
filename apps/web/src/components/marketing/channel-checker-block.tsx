import Link from "next/link";
import { buttonVariants } from "@curvi/ui";
import { checkerCopy } from "./search-copy";

/**
 * "Check your main image" on a main spec's requirements page (P18-10): opens
 * the free checker with that page's channel preset, so the page that ranks
 * for the rules hands the visitor straight to the check.
 */
export function ChannelCheckerBlock({ href }: { href: string }) {
  return (
    <div data-testid="channel-checker" className="mt-10 rounded-xl border border-accent-200 bg-accent-50 p-6">
      <h2 className="text-xl font-semibold text-ink-950">{checkerCopy.requirementsTitle}</h2>
      <p className="mt-2 text-sm text-ink-600">{checkerCopy.requirementsBody}</p>
      <Link href={href} data-testid="channel-checker-link" className={buttonVariants({ className: "mt-4" })}>
        {checkerCopy.requirementsButton}
      </Link>
    </div>
  );
}

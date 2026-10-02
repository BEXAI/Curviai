import { cn } from "@curvi/ui";
import { renewalTerms, type RenewalTermsInput } from "@/lib/billing/renewal-terms";

/**
 * The renewal terms beside a plan's buy button (docs/phases/PHASE_20.md
 * P20-07): set off from the card text in a bordered box so they are clear
 * and conspicuous, right next to the request for consent. No hooks, so the
 * pricing page and the app's billing page can both render it.
 */
export function RenewalTerms({ className, ...input }: RenewalTermsInput & { className?: string }) {
  return (
    <p
      className={cn("mt-3 rounded-md border border-ink-200 bg-ink-50 p-2 text-xs leading-relaxed text-ink-700", className)}
      data-testid={`renewal-terms-${input.tier}`}
    >
      {renewalTerms(input)}
    </p>
  );
}

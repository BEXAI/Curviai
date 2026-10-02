import { buttonVariants } from "@curvi/ui";
import { CLAIM_COPY, claimCtaText } from "@/lib/prospects/copy";
import { ProspectTakedown } from "./prospect-takedown";
import { SignupLink } from "./signup-link";

/**
 * The claim call to action on a prospect's share page (docs/phases/
 * PHASE_18.md P18-04), shown only with this page's live claim link. The
 * signup link carries source=concierge and the claim token, so the new
 * account is attributed to the outreach and starts with this product.
 */
export function ProspectClaimCta({ store, token }: { store: string; token: string }) {
  return (
    <div className="mt-12 rounded-xl bg-ink-950 p-8 text-center" data-testid="prospect-claim">
      <h2 className="text-xl font-bold text-white">{CLAIM_COPY.button}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-ink-300">{claimCtaText(store)}</p>
      <div className="mt-6 flex justify-center">
        <SignupLink
          source="concierge"
          extra={{ claim: token }}
          className={buttonVariants({ variant: "secondary", size: "lg" })}
          data-testid="prospect-claim-link"
        >
          {CLAIM_COPY.button}
        </SignupLink>
      </div>
    </div>
  );
}

/**
 * The footer of a prospect's share page: anyone holding the claim link can
 * take the page down; without it, the email address does the same.
 */
export function ProspectFooter({ token }: { token: string | null }) {
  return (
    <div className="mt-8 text-center text-sm text-ink-600" data-testid="prospect-footer">
      {token ? (
        <ProspectTakedown token={token} />
      ) : (
        <p>
          {CLAIM_COPY.footerQuestion} {CLAIM_COPY.footerEmailOnly}
        </p>
      )}
    </div>
  );
}

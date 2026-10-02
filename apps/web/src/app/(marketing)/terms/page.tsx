import type { Metadata } from "next";
import { LegalHeader, LegalLineText, LegalSection, MailLink } from "@/components/marketing/legal-parts";
import {
  annualReminderSentence,
  entitySentence,
  governingLawSentence,
  replySentence,
  termsChangeSentence,
} from "@/lib/legal/copy";
import { LEGAL_FACTS } from "@/lib/legal/facts";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Terms of service",
  description: "The terms that govern your use of Curvi.",
  path: "/terms",
});

// Every fact, number and date below comes from lib/legal/facts.ts
// (docs/phases/PHASE_20.md P20-23). Changing what this page says moves
// TERMS_VERSION (lib/trust/terms.ts), which is its Last updated date.
export default function TermsPage() {
  const facts = LEGAL_FACTS;
  const reminder = annualReminderSentence(facts);
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <LegalHeader title="Terms of service" lastUpdated={facts.termsLastUpdated} />
      <div className="mt-8 space-y-6 text-sm leading-relaxed text-ink-700">
        <p>These terms apply when you use Curvi. By creating an account or buying a plan, you agree to them.</p>
        <LegalSection id="who-we-are" heading="Who we are" testId="terms-who-we-are">
          <p className="mt-2">
            <LegalLineText line={entitySentence(facts)} />
          </p>
          <p className="mt-2">
            To reach us, email <MailLink email={facts.support.email} />. {replySentence(facts)}
          </p>
        </LegalSection>
        <LegalSection heading="The service">
          <p className="mt-2">
            Curvi turns your product photos into marketplace ready image packs. You get the outputs your plan
            covers, each checked against the channel&apos;s own image rules as they stand when the file is made.
            Marketplaces change their rules, so always confirm current policies before you use a file in a listing.
          </p>
        </LegalSection>
        <LegalSection heading="Your content">
          <p className="mt-2">
            You keep all rights to the photos you upload and the outputs Curvi generates for you. You confirm you
            have the rights to the material you upload. You may not upload content that is unlawful, infringes
            someone else&apos;s rights, or depicts real people without their permission.
          </p>
        </LegalSection>
        <LegalSection id="plans" heading="Plans, renewal and cancellation" testId="terms-plans">
          <p className="mt-2">
            Paid plans are billed monthly or yearly, in advance, in US dollars. Your plan renews automatically at
            the end of each billing period at your plan&apos;s current price, until you cancel. If our price
            changes, we email you before it applies, and you can cancel.{reminder ? ` ${reminder}` : ""}
          </p>
          <p className="mt-2">
            You can cancel any time online in Billing. Your plan stays active until the end of the period you paid
            for, and there is no minimum term. Moving to a bigger plan, or from monthly to yearly billing, takes
            effect straight away. Moving to a smaller plan, or from yearly to monthly billing, takes effect at your
            next renewal.
          </p>
        </LegalSection>
        <LegalSection id="credits" heading="Credits" testId="terms-credits">
          <p className="mt-2">
            Each paid plan adds its credits to your balance when a billing period is paid for, and a yearly plan
            adds the whole year at once. Top ups add credits when you buy them. The free plan adds its credits
            once.
          </p>
          <p className="mt-2">
            When you start a pack, we hold the credits it needs. We charge credits only for files that pass their
            checks, and release the rest when the pack finishes. {facts.creditTermsSentence}
          </p>
          <p className="mt-2">
            If a payment is refunded or disputed, we take back the credits it bought, in proportion to the amount
            returned, without taking your balance below zero. If a dispute ends in our favor, we give those credits
            back. When you move to a bigger plan in the middle of a billing period, we add the difference in
            credits for the time left in it. A move to a smaller plan waits for your next renewal, when the smaller
            plan&apos;s credits start.
          </p>
        </LegalSection>
        <LegalSection id="assistants" heading="Connected assistants" testId="terms-assistants">
          <p className="mt-2">
            You can connect Curvi to an assistant such as ChatGPT. Actions it takes in your workspace with your
            permission count as yours, and credits it spends are charged the same way as in the app.
          </p>
        </LegalSection>
        <LegalSection id="refunds" heading="Refunds" testId="terms-refunds">
          <p className="mt-2">
            {facts.refundPolicy} If you think we charged you by mistake, email{" "}
            <MailLink email={facts.support.email} /> and we will look into it.
          </p>
        </LegalSection>
        <LegalSection id="ai-outputs" heading="AI outputs" testId="terms-ai-outputs">
          <p className="mt-2">
            Curvi uses AI models to make the backgrounds, light, shadows and scenes around your product. The
            pixels of your product come from your photo: we never generate or redraw them. Files with a generated
            background or scene carry a standard label in their metadata that says AI was used.
          </p>
          <p className="mt-2">
            AI can get things wrong. Check every file before you use it, and make sure each listing is accurate
            and follows the rules of the marketplace you sell on. You are responsible for the listings you make
            with Curvi files.
          </p>
        </LegalSection>
        <LegalSection heading="Acceptable use">
          <p className="mt-2">
            Do not use Curvi to create misleading listings, counterfeit goods imagery, or content that violates a
            marketplace&apos;s policies. We may suspend accounts that do.
          </p>
        </LegalSection>
        <LegalSection heading="Warranty and liability">
          <p className="mt-2">
            Curvi is provided as is. We do not guarantee that any marketplace will accept a given image. To the
            maximum extent the law allows, our liability is limited to the amount you paid us in the twelve months
            before the claim.
          </p>
        </LegalSection>
        <LegalSection id="governing-law" heading="Governing law" testId="terms-governing-law">
          <p className="mt-2">
            <LegalLineText line={governingLawSentence(facts)} />
          </p>
        </LegalSection>
        <LegalSection heading="Changes and contact">
          <p className="mt-2">
            {termsChangeSentence(facts)} The date at the top of this page shows the latest update. Questions go to{" "}
            <MailLink email={facts.support.email} />.
          </p>
        </LegalSection>
      </div>
    </div>
  );
}

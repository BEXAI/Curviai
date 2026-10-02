import { Button, Input } from "@curvi/ui";
import type { SignupSourceKey } from "@curvi/pipeline/seed";
import { LandingParamFields } from "./landing-param-fields";

/**
 * Plain GET form so it works without JavaScript. For now it hands the email
 * to the signup page. A real list provider is wired in later. It carries
 * its page's seeded source key (P18-01) in a hidden field, and once in the
 * browser the visitor's landing params too.
 */
export function EmailCapture({
  heading = "Get the full pack for your product",
  buttonLabel = "Start free",
  source = "email_capture",
}: {
  heading?: string;
  buttonLabel?: string;
  source?: SignupSourceKey;
}) {
  return (
    <form action="/signup" method="get" className="mx-auto flex w-full max-w-md flex-col gap-2 sm:flex-row">
      <input type="hidden" name="source" value={source} />
      <LandingParamFields />
      <label className="sr-only" htmlFor={`email-${heading.length}`}>
        Email
      </label>
      <Input
        id={`email-${heading.length}`}
        type="email"
        name="email"
        required
        placeholder="you@yourbrand.com"
        aria-label={heading}
        className="flex-1"
      />
      <Button type="submit" variant="secondary">
        {buttonLabel}
      </Button>
    </form>
  );
}

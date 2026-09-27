import { Button, Input } from "@curvi/ui";

/**
 * Plain GET form so it works without JavaScript. For now it hands the email
 * to the signup page. A real list provider is wired in later.
 */
export function EmailCapture({
  heading = "Get the full pack for your product",
  buttonLabel = "Start free",
}: {
  heading?: string;
  buttonLabel?: string;
}) {
  return (
    <form action="/signup" method="get" className="mx-auto flex w-full max-w-md flex-col gap-2 sm:flex-row">
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

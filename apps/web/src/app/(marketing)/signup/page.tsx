import type { Metadata } from "next";
import { AuthForm } from "@/components/marketing/auth-form";
import { SIGNUP_PAUSED_NOTICE } from "@/components/marketing/acquisition-copy";
import { signupLead } from "@/components/marketing/signup-copy";
import { acquisitionStatus } from "@/lib/acquisition";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Sign up free for AI e-commerce product images",
  description:
    "Create your free Curvi account and turn one product photo into compliant AI product images for Shopify and Amazon. No card needed.",
  path: "/signup",
});

// Rendered per request so the paused packs notice (P18-03) is current; the
// gate itself is cached per process (lib/acquisition.ts).
export const dynamic = "force-dynamic";

export default async function SignupPage() {
  const { state } = await acquisitionStatus();
  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight text-ink-950">Get started with Curvi</h1>
      <p data-testid="signup-lead" className="mt-3 text-ink-600">
        {signupLead()}
      </p>
      {state === "waitlist" ? (
        <p
          data-testid="signup-paused-notice"
          role="status"
          className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {SIGNUP_PAUSED_NOTICE}
        </p>
      ) : null}
      <div className="mt-8">
        <AuthForm mode="signup" />
      </div>
    </div>
  );
}

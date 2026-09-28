import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/marketing/password-forms";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Forgot password",
  description: "Request a password reset link for your Curvi account.",
  path: "/forgot-password",
  noIndex: true,
});

export default function ForgotPasswordPage() {
  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight text-ink-950">Forgot password</h1>
      <p className="mt-3 text-ink-600">We will email you a link to set a new one.</p>
      <div className="mt-8">
        <ForgotPasswordForm />
      </div>
    </div>
  );
}

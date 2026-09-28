import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/marketing/password-forms";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Reset password",
  description: "Set a new password for your Curvi account.",
  path: "/reset-password",
  noIndex: true,
});

export default function ResetPasswordPage() {
  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight text-ink-950">Reset password</h1>
      <p className="mt-3 text-ink-600">Pick a new password for your account.</p>
      <div className="mt-8">
        <ResetPasswordForm />
      </div>
    </div>
  );
}

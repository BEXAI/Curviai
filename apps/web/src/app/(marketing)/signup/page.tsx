import type { Metadata } from "next";
import { AuthForm } from "@/components/marketing/auth-form";

export const metadata: Metadata = {
  title: "Sign up",
  description: "Create your Curvi account and turn one product photo into a full marketplace pack.",
};

export default function SignupPage() {
  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight text-ink-950">Get started with Curvi</h1>
      <p className="mt-3 text-ink-600">
        Start free with 15 credits: one compliant main image, two lifestyle shots and a share page.
      </p>
      <div className="mt-8">
        <AuthForm mode="signup" />
      </div>
    </div>
  );
}

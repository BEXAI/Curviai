import type { Metadata } from "next";
import { AuthForm } from "@/components/marketing/auth-form";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Log in",
  description: "Log in to your Curvi workspace.",
  path: "/login",
});

export default function LoginPage() {
  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight text-ink-950">Log in</h1>
      <p className="mt-3 text-ink-600">Pick up where your last pack left off.</p>
      <div className="mt-8">
        <AuthForm mode="login" />
      </div>
    </div>
  );
}

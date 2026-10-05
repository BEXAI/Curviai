import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Account deleted",
  description: "Your Curvi account has been deleted.",
  path: "/account-deleted",
  noIndex: true,
});

export default async function AccountDeletedPage({
  searchParams,
}: {
  searchParams: Promise<{ signin?: string }>;
}) {
  const { signin } = await searchParams;
  return (
    <div className="mx-auto max-w-md px-6 py-16" data-testid="account-deleted">
      <h1 className="text-3xl font-bold tracking-tight text-ink-950">Your account is deleted</h1>
      <p className="mt-3 text-ink-600">
        Your workspace, products, photos, packs and files are gone from Curvi, and you are signed out.
      </p>
      {signin === "pending" ? (
        <p className="mt-3 text-ink-600" data-testid="signin-pending">
          We remove your sign in details by hand within a few days. Email support@curvi.ai if you want to know when it
          is done.
        </p>
      ) : null}
      <p className="mt-6 text-sm text-ink-500">
        Thanks for trying Curvi. You are welcome back any time.{" "}
        <Link href="/" className="font-medium text-ink-900 underline">
          Back to the home page
        </Link>
      </p>
    </div>
  );
}

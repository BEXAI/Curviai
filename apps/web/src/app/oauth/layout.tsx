import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/marketing/site-header";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * The OAuth pages' own minimal layout (PHASE_19 P19-09): the Curvi mark and
 * the page, with no marketing header or footer, so nothing on the way back
 * to ChatGPT links to pricing (OpenAI's plugin guidelines forbid upselling,
 * docs/verification.md, "PHASE_19", O6). The mark is not a link for the
 * same reason. Not indexed.
 */
export default function OAuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-10 text-ink-900 sm:py-16">
      <Wordmark className="h-8 w-auto" />
      <main className="mt-8 w-full max-w-md">{children}</main>
    </div>
  );
}

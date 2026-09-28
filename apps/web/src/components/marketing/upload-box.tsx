"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { buttonVariants, cn } from "@curvi/ui";

/**
 * Above the fold call to action. Nothing is uploaded or processed from the
 * marketing page yet, and the copy says so: a dropped photo only opens the
 * signup page, and the seller adds the photo in the app. The free tools do
 * run real checks in the browser, so the box points to them for an instant
 * result.
 */
export function UploadBox({ freeCredits }: { freeCredits: number }) {
  const router = useRouter();
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      data-testid="hero-upload-box"
      className={cn(
        "rounded-xl border-2 border-dashed p-6 text-center transition-colors",
        dragOver ? "border-accent-500 bg-accent-500/10" : "border-white/15 bg-white/5",
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        // Stop the browser from opening the file, then start signup. The
        // file itself is not kept.
        event.preventDefault();
        setDragOver(false);
        router.push("/signup");
      }}
    >
      <p className="text-sm font-medium text-white">Turn one product photo into a full pack</p>
      <p className="mt-1 text-sm text-ink-400">
        Create a free account with {freeCredits} credits, then upload your photo in the app. Nothing is
        uploaded from this page.
      </p>
      <div className="mt-4 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Link href="/signup" className={buttonVariants({ variant: "secondary", size: "lg" })}>
          Start free
        </Link>
        <span className="text-xs text-ink-400">No card needed.</span>
      </div>
      <p className="mt-4 text-xs text-ink-400">
        Want a check right now?{" "}
        <Link href="/tools/main-image-checker" className="font-medium text-ink-200 underline hover:text-white">
          Test your main image free
        </Link>{" "}
        in your browser, no account needed.
      </p>
    </div>
  );
}

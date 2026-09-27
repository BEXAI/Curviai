"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, cn } from "@curvi/ui";

/**
 * Above the fold upload box. It does not process anything on the marketing
 * page. Choosing a file routes to signup, where the real pipeline lives. The
 * free tools do run real checks in the browser.
 */
export function UploadBox() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function goToSignup() {
    router.push("/signup");
  }

  return (
    <div
      className={cn(
        "rounded-xl border-2 border-dashed p-6 text-center transition-colors",
        dragOver ? "border-accent-500 bg-accent-50" : "border-ink-200 bg-ink-50",
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        goToSignup();
      }}
    >
      <p className="text-sm font-medium text-ink-900">Drop a product photo to see your pack</p>
      <p className="mt-1 text-sm text-ink-500">One photo in. A full marketplace pack out.</p>
      <div className="mt-4 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="sr-only"
          aria-label="Upload a product photo"
          onChange={goToSignup}
        />
        <Button variant="secondary" size="lg" onClick={() => inputRef.current?.click()}>
          Upload a photo
        </Button>
        <span className="text-xs text-ink-400">Free to try. No card needed.</span>
      </div>
    </div>
  );
}

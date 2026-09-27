"use client";

import { useState } from "react";
import Link from "next/link";
import { cn } from "@curvi/ui";

export interface MobileMenuLink {
  href: string;
  label: string;
}

export function MobileMenu({ links }: { links: MobileMenuLink[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="mobile-menu"
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-ink-700 transition-colors hover:bg-ink-50"
      >
        <svg viewBox="0 0 20 20" fill="none" className="size-5" aria-hidden="true">
          {open ? (
            <path d="m5 5 10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          ) : (
            <path d="M3.5 6h13M3.5 10h13M3.5 14h13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          )}
        </svg>
      </button>
      <div
        id="mobile-menu"
        className={cn(
          "absolute inset-x-0 top-16 border-b border-ink-950/10 bg-white shadow-raised",
          open ? "block" : "hidden",
        )}
      >
        <nav aria-label="Mobile" className="mx-auto max-w-6xl space-y-1 px-6 py-4">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="block rounded-lg px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50 hover:text-ink-950"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}

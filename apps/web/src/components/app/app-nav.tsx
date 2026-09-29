"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@curvi/ui";

const LINKS = [
  { href: "/app", label: "Dashboard" },
  { href: "/app/new", label: "New pack" },
  { href: "/app/products", label: "Products" },
  { href: "/app/library", label: "Library" },
  { href: "/app/brand", label: "Brand kit" },
  { href: "/app/billing", label: "Billing" },
  { href: "/app/settings", label: "Settings" },
  // Public pages, so a seller can reach them without leaving through the home page.
  { href: "/gallery", label: "Gallery" },
  { href: "/tools/main-image-checker", label: "Free tools" },
];

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="App" className="flex flex-wrap items-center gap-1">
      {LINKS.map((link) => {
        const active =
          link.href === "/app"
            ? pathname === "/app"
            : link.href.startsWith("/tools")
              ? pathname.startsWith("/tools")
              : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-sm font-medium transition-all duration-200",
              active
                ? "bg-ink-900 text-white shadow-[0_0_0_1px_rgb(255_255_255/0.2),0_6px_20px_-8px_rgb(236_72_153/0.6)]"
                : "text-ink-600 hover:bg-ink-100 hover:text-ink-900",
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

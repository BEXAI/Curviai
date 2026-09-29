"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@curvi/ui";

const LINKS = [
  { href: "/app", label: "Dashboard" },
  { href: "/app/new", label: "New pack" },
  { href: "/app/products", label: "Products" },
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
              "rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active ? "bg-ink-900 text-white" : "text-ink-600 hover:bg-ink-100 hover:text-ink-900",
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

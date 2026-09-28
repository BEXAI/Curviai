import Link from "next/link";
import { cn } from "@curvi/ui";
import { HeaderActions } from "./header-actions";

const navLinks = [
  { href: "/pricing", label: "Pricing" },
  { href: "/tools/main-image-checker", label: "Free tools" },
  { href: "/gallery", label: "Gallery" },
  { href: "/help", label: "Help" },
];

export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 font-display text-xl font-bold tracking-tight text-ink-950",
        className,
      )}
    >
      <img src="/brand/curvi-mark-256.png" alt="" width={32} height={32} className="h-8 w-8 rounded-lg" />
      Curvi
    </span>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-night/80 backdrop-blur">
      <div className="relative mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-6">
        <Link href="/" aria-label="Curvi home">
          <Wordmark className="text-white" />
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-6 md:flex">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm font-medium text-ink-300 transition-colors hover:text-white"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <HeaderActions links={navLinks} />
      </div>
    </header>
  );
}

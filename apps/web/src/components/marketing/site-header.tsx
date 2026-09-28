import Link from "next/link";
import { cn } from "@curvi/ui";
import { HeaderActions } from "./header-actions";

const navLinks = [
  { href: "/pricing", label: "Pricing" },
  { href: "/tools/main-image-checker", label: "Free tools" },
  { href: "/gallery", label: "Gallery" },
  { href: "/help", label: "Help" },
];

/** The Curvi wordmark (logo mark plus name), used wherever the brand name is
 * a title. Transparent PNG, so it reads on the dark marketing canvas and the
 * light app header alike. Its width follows from the height set here. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <img
      src="/brand/curvi-wordmark.png"
      alt="Curvi"
      width={518}
      height={160}
      className={cn("h-8 w-auto", className)}
    />
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

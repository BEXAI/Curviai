import Link from "next/link";

const navLinks = [
  { href: "/pricing", label: "Pricing" },
  { href: "/tools/main-image-checker", label: "Free tools" },
  { href: "/gallery", label: "Gallery" },
  { href: "/help", label: "Help" },
];

export function Wordmark() {
  return (
    <span className="inline-flex items-baseline text-xl font-bold tracking-tight text-ink-950">
      Curvi
      <span className="ml-0.5 inline-block h-2 w-2 translate-y-[-1px] rounded-full bg-accent-500" aria-hidden="true" />
    </span>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-ink-100 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-6">
        <Link href="/" aria-label="Curvi home">
          <Wordmark />
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-6 md:flex">
          {navLinks.map((link) => (
            <Link key={link.href} href={link.href} className="text-sm font-medium text-ink-600 hover:text-ink-950">
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <Link href="/login" className="hidden text-sm font-medium text-ink-600 hover:text-ink-950 sm:block">
            Log in
          </Link>
          <Link
            href="/signup"
            className="inline-flex h-10 items-center justify-center rounded-lg bg-ink-900 px-4 text-sm font-medium text-white transition-colors hover:bg-ink-800"
          >
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}

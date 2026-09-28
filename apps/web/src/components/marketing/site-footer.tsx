import Link from "next/link";
import { CookieSettingsLink } from "../cookie-consent";
import { Wordmark } from "./site-header";

const productLinks = [
  { href: "/pricing", label: "Pricing" },
  { href: "/gallery", label: "Gallery" },
  { href: "/tools/main-image-checker", label: "Main Image Checker" },
  { href: "/tools/white-background-fixer", label: "White Background Fixer" },
  { href: "/tools/marketplace-resizer", label: "Marketplace Resizer" },
];

const resourceLinks = [
  { href: "/help", label: "Help center" },
  { href: "/channels/amazon-main/image-requirements", label: "Amazon image requirements" },
  { href: "/channels/google-merchant-main/image-requirements", label: "Google image requirements" },
  { href: "/channels/shopify-product/image-requirements", label: "Shopify image requirements" },
  { href: "/for/beauty", label: "Curvi for beauty brands" },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-white/10 bg-night">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Wordmark className="text-white" />
            <p className="mt-3 max-w-xs text-sm text-ink-400">
              Studio product photos for marketplaces and social, from one photo, without changing your product.
            </p>
          </div>
          <div>
            <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-ink-300">Product</h3>
            <ul className="mt-3 space-y-2">
              {productLinks.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-sm text-ink-400 transition-colors hover:text-white">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-ink-300">Resources</h3>
            <ul className="mt-3 space-y-2">
              {resourceLinks.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-sm text-ink-400 transition-colors hover:text-white">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-ink-300">Legal</h3>
            <ul className="mt-3 space-y-2 text-sm">
              <li>
                <Link href="/terms" className="text-ink-400 transition-colors hover:text-white">
                  Terms of service
                </Link>
              </li>
              <li>
                <Link href="/privacy" className="text-ink-400 transition-colors hover:text-white">
                  Privacy policy
                </Link>
              </li>
              <li>
                <CookieSettingsLink className="text-ink-400 transition-colors hover:text-white" />
              </li>
              <li>
                <a href="mailto:hello@curvi.ai" className="text-ink-400 transition-colors hover:text-white">
                  hello@curvi.ai
                </a>
              </li>
            </ul>
          </div>
        </div>
        <p className="mt-10 text-xs text-ink-500">
          Channel rules are checked against official documentation and can change. Always confirm current
          marketplace policies before publishing.
        </p>
      </div>
    </footer>
  );
}

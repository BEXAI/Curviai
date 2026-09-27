import Link from "next/link";
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
    <footer className="border-t border-ink-100 bg-ink-50">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Wordmark />
            <p className="mt-3 max-w-xs text-sm text-ink-500">
              Studio product photos and videos for every marketplace, from one photo, without changing your product.
            </p>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink-900">Product</h3>
            <ul className="mt-3 space-y-2">
              {productLinks.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-sm text-ink-600 hover:text-ink-950">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink-900">Resources</h3>
            <ul className="mt-3 space-y-2">
              {resourceLinks.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-sm text-ink-600 hover:text-ink-950">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink-900">Legal</h3>
            <ul className="mt-3 space-y-2 text-sm text-ink-500">
              <li>Terms of service, published at launch</li>
              <li>Privacy policy, published at launch</li>
              <li>
                <a href="mailto:hello@curvi.ai" className="text-ink-600 hover:text-ink-950">
                  hello@curvi.ai
                </a>
              </li>
            </ul>
          </div>
        </div>
        <p className="mt-10 text-xs text-ink-400">
          Curvi is in early access. Copy on this site describes the product as designed. Channel rules are checked
          against official documentation and can change. Always confirm current marketplace policies before publishing.
        </p>
      </div>
    </footer>
  );
}

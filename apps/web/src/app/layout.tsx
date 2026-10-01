import type { Metadata } from "next";
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";
import { AdsPixel } from "@/components/ads-pixel";
import { Analytics } from "@/components/analytics";
import { CookieConsent } from "@/components/cookie-consent";
import { siteUrl } from "@/lib/env";
import { SITE_DESCRIPTION, SITE_KEYWORDS, SITE_NAME, SITE_TITLE } from "@/lib/seo";
import "./globals.css";

// Geist for text, Bricolage Grotesque for display headings, Geist Mono for
// labels and numbers. The CSS variable names stay the same so every
// font-sans, font-display and font-mono utility picks them up.
const inter = Geist({ subsets: ["latin"], variable: "--font-inter" });
const grotesk = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-grotesk" });
const jbMono = Geist_Mono({ subsets: ["latin"], variable: "--font-jbmono" });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: SITE_TITLE,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: SITE_KEYWORDS,
  category: "E-commerce software",
  creator: SITE_NAME,
  publisher: SITE_NAME,
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    locale: "en_US",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  robots: {
    googleBot: {
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${grotesk.variable} ${jbMono.variable}`}>
      <body className="theme-dark min-h-screen bg-night font-sans text-ink-950 antialiased">
        {children}
        <Analytics />
        <AdsPixel />
        <CookieConsent />
      </body>
    </html>
  );
}

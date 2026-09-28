import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { Analytics } from "@/components/analytics";
import { siteUrl } from "@/lib/env";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const grotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-grotesk" });
const jbMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jbmono" });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: "Curvi. Shot once. Ready everywhere.",
    template: "%s | Curvi",
  },
  description:
    "Studio product photos and videos for every marketplace, from one photo, without changing your product.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${grotesk.variable} ${jbMono.variable}`}>
      <body className="min-h-screen bg-white font-sans text-ink-950 antialiased">
        {children}
        <Analytics />
      </body>
    </html>
  );
}

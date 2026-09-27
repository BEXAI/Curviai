import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Curvi. Shot once. Ready everywhere.",
    template: "%s | Curvi",
  },
  description:
    "Studio product photos and videos for every marketplace, from one photo, without changing your product.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-slate-900 antialiased">{children}</body>
    </html>
  );
}

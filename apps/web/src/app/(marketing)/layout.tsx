import { SiteHeader } from "@/components/marketing/site-header";
import { SiteFooter } from "@/components/marketing/site-footer";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-night text-ink-900">
      <SiteHeader />
      <main className="theme-dark flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}

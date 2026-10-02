import Link from "next/link";
import { buttonVariants } from "@curvi/ui";
import { HelpIndex } from "@/components/marketing/help-index";
import { liveHelpArticles, helpClosing } from "@/components/marketing/help-articles";
import { SignupLink } from "@/components/marketing/signup-link";
import { LEGAL_FACTS } from "@/lib/legal/facts";
import { supportReplyTime } from "@/lib/legal/copy";
import { pageMetadata } from "@/lib/seo";
export const metadata = pageMetadata({ title: "Curvi help center", description: "Answers about your photos, listing packs, credits and account.", path: "/help" });
export default function HelpPage() {
  const articles = liveHelpArticles();
  return <div className="mx-auto max-w-3xl px-6 py-16">
    <h1 className="text-4xl font-semibold text-ink-950">Help center</h1>
    <p className="mt-4 text-ink-600">Find an answer, or <Link href="/support" className="underline">contact us</Link> for help with your pack or account.</p>
    <p className="mt-3 text-sm text-ink-600">If something is missing, email <a className="underline" href={`mailto:${LEGAL_FACTS.support.email}`}>{LEGAL_FACTS.support.email}</a> and a person replies within {supportReplyTime(LEGAL_FACTS)}.</p>
    <HelpIndex articles={articles.map(({ slug, title, group }) => ({ slug, title, group }))} />
    <div className="mt-10 rounded-xl border border-ink-100 p-8 text-center"><h2 className="text-xl font-semibold">Ready to try it?</h2><p className="mt-2 text-sm text-ink-600">{helpClosing}</p><SignupLink source="help" className={buttonVariants({ variant: "secondary", size: "lg", className: "mt-5" })}>Get started</SignupLink></div>
  </div>;
}

import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@curvi/ui";

export const metadata: Metadata = {
  title: "Help center",
  description:
    "Plain answers about how Curvi works: uploads, credits, compliance checks, brand kits, publishing and billing.",
};

interface HelpArticle {
  slug: string;
  title: string;
  body: string[];
}

const articles: HelpArticle[] = [
  {
    slug: "what-photo-should-i-upload",
    title: "What photo should I upload?",
    body: [
      "One clear photo of your product is enough. Natural light, the whole product in frame, and as little blur as possible. A phone photo on a kitchen table works fine because Curvi rebuilds everything around the product.",
      "Higher resolution helps. If your photo's longest side is 2000 px or more, the pack can include full size marketplace images without upscaling. Avoid photos where part of the product is cut off, since Curvi never invents product pixels that were not in your photo.",
    ],
  },
  {
    slug: "how-credits-work",
    title: "How do credits work?",
    body: [
      "Every plan includes a monthly credit allowance. Simple deterministic assets like a white background main image, a cutout or a resize cost 0.5 credit. A generative still costs 1 credit at up to 2K, or 3 credits for 4K and Pro models. A templated video costs 2 credits, generative video costs 1 credit per second on Lite and 3 on premium, and a UGC avatar ad costs 30 credits.",
      "A typical full pack uses about 40 to 60 credits. Unused subscription credits roll over for one cycle, capped at one month of your allowance. Top ups last 12 months.",
    ],
  },
  {
    slug: "what-the-compliance-report-means",
    title: "What does the compliance report mean?",
    body: [
      "Every file Curvi produces is measured against the channel spec it was made for: background value, product fill percent, resolution, format, file size and text policy. The report shows the measured numbers next to each rule.",
      "A green badge means every check passed on the actual output pixels. If a render fails a check, Curvi fixes or regenerates it before you see it, so you should rarely see a failing report on a delivered file.",
    ],
  },
  {
    slug: "will-ai-change-my-product",
    title: "Will the AI change my product or label?",
    body: [
      "No. This is the core promise. Curvi masks your product first and treats those pixels as untouchable. Backgrounds, shadows, scenes and lighting are generated around the mask.",
      "That is why label text, logos, stitching and textures in the output match your photo exactly. If a generated scene would require repainting the product itself, Curvi does not produce it.",
    ],
  },
  {
    slug: "which-channels-are-supported",
    title: "Which channels are supported?",
    body: [
      "Images: Amazon main and secondary, Amazon A plus modules, Shopify product and hero banner, Google Merchant main and lifestyle, Etsy, eBay, Walmart, TikTok Shop, Meta feed and story, and Pinterest.",
      "Video: listing video for Amazon and vertical social video. Each export is sized, formatted and named for its channel, and marketplace files never carry badges or watermarks.",
    ],
  },
  {
    slug: "what-is-a-brand-kit",
    title: "What is a brand kit?",
    body: [
      "A brand kit stores your colors, fonts, logo and preferred scene styles. Once it is set, every pack Curvi builds uses it, so your Amazon gallery, your Shopify store and your ads all look like one brand.",
      "Starter includes 1 brand kit, Pro includes 3, and Agency workspaces get one per client workspace.",
    ],
  },
  {
    slug: "what-is-the-fresh-creative-drop",
    title: "What is the Fresh Creative Drop?",
    body: [
      "Every Monday, Curvi generates new seasonal and ad variants for your top 3 products and puts them in your library to review. Nothing is published automatically, you approve what you like.",
      "The drop follows the season calendar, so ahead of Prime Day, Black Friday and the holidays you get themed variants early. It is included on Growth and above.",
    ],
  },
  {
    slug: "billing-and-cancellation",
    title: "How do billing and cancellation work?",
    body: [
      "Plans are monthly or annual, and annual pays about 17 percent less per month. You can cancel any time from settings, and your plan stays active until the end of the paid period. No cancellation calls, no forms.",
      "Top up credits you bought stay usable for 12 months even if you cancel the subscription. The free plan needs no card at all.",
    ],
  },
];

export default function HelpPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-4xl font-bold tracking-tight text-ink-950">Help center</h1>
      <p className="mt-4 text-lg text-ink-600">
        Plain answers, no ticket required. If something is missing, email{" "}
        <a href="mailto:hello@curvi.ai" className="font-medium text-ink-900 underline">
          hello@curvi.ai
        </a>{" "}
        and a human replies.
      </p>

      <nav aria-label="Articles" className="mt-8 rounded-xl border border-ink-100 bg-ink-50 p-5">
        <h2 className="text-sm font-semibold text-ink-900">In this help center</h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {articles.map((article) => (
            <li key={article.slug}>
              <a href={`#${article.slug}`} className="text-sm text-ink-600 underline hover:text-ink-950">
                {article.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mt-10 space-y-12">
        {articles.map((article) => (
          <article key={article.slug} id={article.slug} className="scroll-mt-24">
            <h2 className="text-2xl font-semibold text-ink-950">{article.title}</h2>
            {article.body.map((paragraph) => (
              <p key={paragraph.slice(0, 40)} className="mt-3 text-ink-600">
                {paragraph}
              </p>
            ))}
          </article>
        ))}
      </div>

      <div className="mt-16 rounded-xl border border-ink-100 p-8 text-center">
        <h2 className="text-xl font-semibold text-ink-950">Ready to try it?</h2>
        <p className="mt-2 text-sm text-ink-600">Start free with 15 credits. No card needed.</p>
        <Link
          href="/signup"
          className={buttonVariants({ variant: "secondary", size: "lg", className: "mt-5" })}
        >
          Get started
        </Link>
      </div>
    </div>
  );
}

import { QC_THRESHOLDS } from "@curvi/pipeline/qc-thresholds";
import { creditCosts } from "@curvi/pipeline/seed";
import { isStripeConfigured } from "@/lib/env";
import {
  amazonMainRules,
  annualSavingsPhrase,
  comingSoonFilesSentence,
  formatCredits,
  freeCredits,
  liveFilesPhrase,
  topUpMonths,
  typicalPackCredits,
  UNUSED_CREDITS_SENTENCE,
} from "@/lib/marketing-facts";

/**
 * Help center articles. Numbers come from the seeds and the spec registry
 * through lib/marketing-facts, so the answers move with the pricing and the
 * channel rules.
 *
 * structured decides which articles reach the FAQPage JSON-LD that answer
 * engines quote:
 * - "always": true today.
 * - "when_purchasable": true once paid plans can be bought (Stripe set up).
 * - "never": describes a feature that is coming soon.
 */
export interface HelpArticle {
  slug: string;
  title: string;
  body: string[];
  status?: "coming_soon";
  structured: "always" | "when_purchasable" | "never";
}

const main = amazonMainRules();

/** The help article on the API, MCP server, CLI and skill; llms.txt links it. */
export const AGENT_HELP_SLUG = "ai-agents-and-the-command-line";

export const helpArticles: HelpArticle[] = [
  {
    slug: "what-photo-should-i-upload",
    title: "What photo should I upload?",
    body: [
      "One clear photo of your product is enough. Natural light, the whole product in frame, and as little blur as possible. A phone photo on a kitchen table works fine because Curvi rebuilds everything around the product.",
      `Higher resolution helps. If your photo's longest side is ${main.width} px or more, the pack can include full size marketplace images without upscaling. Avoid photos where part of the product is cut off, since Curvi never invents product pixels that were not in your photo.`,
    ],
    structured: "always",
  },
  {
    slug: "how-credits-work",
    title: "How do credits work?",
    body: [
      `Every paid plan includes a monthly credit allowance, and the free plan gives you ${freeCredits()} credits once. A white background main image, a cutout, a resize or a background sweep costs ${formatCredits(creditCosts.deterministic)}. A generative lifestyle scene costs ${formatCredits(creditCosts.generativeStill)}.`,
      `A typical listing pack of still images uses about ${typicalPackCredits()} credits. You are only charged for files that pass their checks. ${UNUSED_CREDITS_SENTENCE} Top up credits stay usable for ${topUpMonths()} months.`,
    ],
    structured: "always",
  },
  {
    slug: "what-the-compliance-report-means",
    title: "What does the compliance report mean?",
    body: [
      "Every file Curvi produces is measured against the channel spec it was made for: background, product fill and resolution. The report shows the measured numbers next to each rule.",
      "A green badge means every check passed on the actual output pixels. If a render fails a check, Curvi retries it. A file that still fails is marked for review instead of shipping, and you are not charged for it.",
    ],
    structured: "always",
  },
  {
    slug: "will-ai-change-my-product",
    title: "Will the AI change my product or label?",
    body: [
      `No. Curvi never redraws your product. It cuts your product out of your photo, places it on the new background, and checks every finished file: the average color difference inside your product must be at most ${QC_THRESHOLDS.main.maxMeanDeltaE} for main images and ${QC_THRESHOLDS.other.maxMeanDeltaE} for the rest.`,
      "Resizing for each channel means most files are not byte for byte copies, and the check measures exactly that.",
    ],
    structured: "always",
  },
  {
    slug: "which-channels-are-supported",
    title: "Which channels are supported?",
    body: [
      `You pick the channels for each pack. Curvi makes ${liveFilesPhrase()}. Each file is sized for its channel, and marketplace files never carry badges or watermarks.`,
      [comingSoonFilesSentence(), "Video for Amazon listings and vertical social feeds is coming soon."]
        .filter((sentence) => sentence.length > 0)
        .join(" "),
    ],
    structured: "always",
  },
  {
    slug: "what-is-a-brand-kit",
    title: "What is a brand kit?",
    body: [
      "A brand kit stores your brand colors. Once they are set, packs use your first brand color for the brand color background shot.",
      "Your fonts set the text on infographic and dimensions images. Your logo goes in a free corner of infographic and social images, never on the product. Your style preset sets the surface for lifestyle scenes and the backdrop for banners and social images. Each workspace has one brand kit, and more brand kits on higher plans are coming soon.",
    ],
    structured: "always",
  },
  {
    slug: "what-is-the-fresh-creative-drop",
    title: "What is the Fresh Creative Drop?",
    status: "coming_soon",
    body: [
      "The Fresh Creative Drop is coming soon. Each week, Curvi will make new seasonal and ad variants for your top products and put them in your library to review. Nothing goes live unless you approve it.",
      "The drop will follow the retail calendar, so themed variants arrive ahead of big shopping events. It is not available on any plan yet.",
    ],
    structured: "never",
  },
  {
    slug: AGENT_HELP_SLUG,
    title: "Can I make packs from an AI agent or the command line?",
    status: "coming_soon",
    body: [
      "Not yet. A public Curvi API, an MCP server for AI assistants, a curvi command line tool and a Curvi skill for AI coding agents are coming soon. Each will make the same packs as the app, with the same checks, the same compliance report and the same credits.",
      "Access will use API keys you make and revoke in your workspace settings. Until then, make packs at the New pack page in the app, and use the free Amazon main image checker in the browser.",
    ],
    structured: "never",
  },
  {
    slug: "billing-and-cancellation",
    title: "How do billing and cancellation work?",
    body: [
      `Plans are monthly or annual, and annual costs ${annualSavingsPhrase()} less per month. You can cancel any time from the Billing page in the app, through the customer portal, and your plan stays active until the end of the period you paid for. No cancellation calls, no forms.`,
      `Top up credits you bought stay usable for ${topUpMonths()} months even if you cancel the subscription. The free plan needs no card at all.`,
    ],
    structured: "when_purchasable",
  },
];

/** Articles that go into the FAQPage JSON-LD right now. */
export function structuredHelpArticles(): HelpArticle[] {
  const purchasable = isStripeConfigured();
  return helpArticles.filter(
    (article) => article.structured === "always" || (article.structured === "when_purchasable" && purchasable),
  );
}

export const helpClosing = `Start free with ${freeCredits()} credits. No card needed.`;

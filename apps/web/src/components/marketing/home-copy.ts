import { creditCosts } from "@curvi/pipeline/seed";
import {
  comingSoonChannelNames,
  formatCredits,
  freeCredits,
  freeCreditsReach,
  joinList,
  liveChannelNames,
  typicalPackCredits,
  type Availability,
} from "@/lib/marketing-facts";

/**
 * Copy for the home page. Numbers come from the seeds through
 * lib/marketing-facts, and anything that does not run in production is
 * marked coming soon, so the page and its FAQPage JSON-LD only state what
 * is true today.
 */

export const homeHero = {
  eyebrow: "Built for marketplace sellers",
  lead: `Studio product photos for ${joinList(liveChannelNames())}, from one photo, without changing your product.`,
  proof:
    "Every file is measured against the channel rules before you download it. We keep your real product pixels, so labels never warp.",
  sliderCaption: "Illustration, not a customer photo. Drag the divider: the product stays, the background changes.",
};

export const homeSteps = [
  {
    title: "Upload one photo",
    body: "A phone photo of your product is enough. Curvi masks the product so its pixels are locked before anything else happens.",
  },
  {
    title: "Curvi builds the pack",
    body: "A compliant main image, lifestyle scenes and channel crops render on a live progress board. Every file is measured against the channel rules.",
  },
  {
    title: "Download the pack",
    body: "Files come sized for each channel and grouped by channel, with a compliance report on each.",
  },
];

export type HomeFeatureKey =
  | "fidelity"
  | "compliance"
  | "channels"
  | "brandKit"
  | "freshCreativeDrop"
  | "directPublishing";

export interface HomeFeature {
  key: HomeFeatureKey;
  title: string;
  body: string;
  status: Availability;
}

/** Live features first, then the ones on the way, each with a Coming soon label. */
export const homeFeatures: HomeFeature[] = [
  {
    key: "fidelity",
    title: "Fidelity lock",
    body: "Your real product pixels are never regenerated. Labels, logos and textures in the output match your photo exactly.",
    status: "live",
  },
  {
    key: "compliance",
    title: "Compliance report",
    body: "Every file ships with measured checks for its channel: background, product fill and resolution.",
    status: "live",
  },
  {
    key: "channels",
    title: "Channel ready files",
    body: `Files for ${joinList(liveChannelNames())}, each at the right size for its channel. ${joinList(comingSoonChannelNames())} are coming soon.`,
    status: "live",
  },
  {
    key: "brandKit",
    title: "Brand kit",
    body: "Save your brand colors once and packs use them for brand color backgrounds. Your fonts, logo and scene styles in packs are coming soon.",
    status: "live",
  },
  {
    key: "freshCreativeDrop",
    title: "Fresh Creative Drop",
    body: "New seasonal and ad variants for your top products, waiting in your library each week for you to approve.",
    status: "coming_soon",
  },
  {
    key: "directPublishing",
    title: "Direct publishing",
    body: "Send approved images straight to your Shopify store. Until then, you download the pack grouped by channel.",
    status: "coming_soon",
  },
];

export const homeFeaturesIntro = "No prompts anywhere. Upload, review, download.";

export interface HomeFaq {
  q: string;
  a: string;
}

/**
 * Every answer here is true today, so all of them feed the FAQPage JSON-LD.
 * An answer about a feature that is not live must say it is coming soon; a
 * test enforces that.
 */
export const homeFaqs: HomeFaq[] = [
  {
    q: "Does the AI change my product?",
    a: "No. Curvi masks your product first and only rebuilds what is around it: backgrounds, lighting and scenes. Product pixels inside the mask are never regenerated, which is why labels never warp.",
  },
  {
    q: "What do I need to start?",
    a: "One photo per product. A phone photo on a table works. Higher resolution photos give the pack more room for large formats.",
  },
  {
    q: "Which channels are covered?",
    a: `Amazon main and secondary images plus A plus banners, Shopify product images and hero banners, Google Merchant lifestyle images, and Meta feed and story crops. ${joinList([...comingSoonChannelNames(), "video formats"])} are coming soon.`,
  },
  {
    q: "How do credits work?",
    a: `A white background main image, a cutout, a resize or a background sweep costs ${formatCredits(creditCosts.deterministic)}. A generative lifestyle scene costs ${formatCredits(creditCosts.generativeStill)}. A typical listing pack of still images uses about ${typicalPackCredits()} credits, and you are only charged for files that pass their checks.`,
  },
  {
    q: "What if a file fails a marketplace check?",
    a: "Curvi measures every file against the channel spec and retries a render that fails. A file that still fails is marked for review instead of shipping, and you are not charged for it. The report shows the measured numbers.",
  },
  {
    q: "Can I try it without a card?",
    a: `Yes. The free plan gives you ${freeCredits()} credits once, ${freeCreditsReach()}. The free tools on this site need no account at all.`,
  },
];

export const homeClosing = {
  title: "Your next pack is one photo away",
  body: `Start free with ${freeCredits()} credits, ${freeCreditsReach()} for your first product.`,
};

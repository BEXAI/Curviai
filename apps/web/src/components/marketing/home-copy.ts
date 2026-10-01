import { creditCosts } from "@curvi/pipeline/seed";
import {
  comingSoonFilesSentence,
  formatCredits,
  freeCredits,
  freeCreditsReach,
  joinList,
  liveChannelNames,
  liveChannelShortList,
  liveChannels,
  liveFilesPhrase,
  typicalPackChannelNames,
  typicalPackCredits,
  UNUSED_CREDITS_SENTENCE,
  type Availability,
} from "@/lib/marketing-facts";
import { answerFaqs } from "./pillar-copy";

/**
 * Copy for the home page. Numbers come from the seeds through
 * lib/marketing-facts, and anything that does not run in production is
 * marked coming soon, so the page and its FAQPage JSON-LD only state what
 * is true today.
 */

export const homeHero = {
  eyebrow: "AI product images for e-commerce",
  // Keeps the exact phrase "AI product images for Amazon, Shopify" for search,
  // without opening on the same words as the badge above it.
  lead: `Turn one photo into AI product images for ${liveChannelShortList()}, without changing your product.`,
  proof:
    "Every file is measured against the channel rules before you download it. We keep your real product pixels and generate only the light, shadow and setting around them, so labels never warp.",
  sliderCaption: "A real Curvi result: the seller's photo, then one finished file. Drag the divider: the product stays, the background changes.",
};

/**
 * The hero's calls to action. Kept apart from homeHero, whose values the
 * claims test reads as plain strings.
 */
export const homeHeroCtas = {
  primary: { label: "Start free", href: "/signup" },
  secondary: { label: "Test your main image free", href: "/tools/main-image-checker" },
};

export const homeHeroNote = `No card needed. Start with ${freeCredits()} free credits.`;

/** The three live promises on the hero's glass card, keyed to the matching home feature icon. */
export const homeHeroFeatures: { key: HomeFeatureKey; label: string }[] = [
  { key: "fidelity", label: "Your product, never redrawn" },
  { key: "compliance", label: "Measured against channel rules" },
  { key: "channels", label: `Files sized for ${liveChannelNames().length} channels` },
];

/** The section under the hero, around the before and after slider. */
export const homeProof = {
  eyebrow: "Before and after",
  title: "Your product stays.",
  titleMuted: "The background changes.",
  galleryLink: "See more before and after examples",
  differenceTitle: "Your product is never redrawn. That is the difference.",
  difference:
    "General AI image generators redraw the whole picture, product included, and wording, caps and colors can still drift. Curvi cuts your product out of your own photo and builds only the background and scene around it, then checks every file for color change inside your product before it ships.",
};

export const homeHowItWorks = {
  title: "How it works",
};

/** What a typical pack holds. The files and credits come from the new pack form's own estimate. */
export const homePack = {
  eyebrow: "What a pack contains",
  title: "Everything a listing needs,",
  titleMuted: "nothing you have to prompt",
  intro: `A typical pack for ${typicalPackChannelNames()} holds these files. You pick the channels for each pack, and every file is sized for its channel.`,
  summary: `About ${typicalPackCredits()} credits for this pack. You are only charged for files that pass their checks.`,
  lifestyleCaption: "Scenes built around your real product photo.",
  sweepCaption: "Gray, and your first brand kit color.",
  onTheWay: "On the way",
};

export const homeReport = {
  eyebrow: "Compliance report",
  title: "Proof on every file,",
  titleMuted: "not promises",
  lead: "When the badge turns green it is because the pixels were measured. Here is an example of the report a main image ships with.",
  note: "A file that still fails is marked for review instead of shipping, and you are not charged for it.",
};

export const homeChannels = {
  title: "One photo.",
  titleMuted: `${liveChannelNames().length} channels.`,
  /** The channel ready files tile beside the heading; the tiles below already name every channel. */
  tileBody: `Every file comes at the right size for its channel and is checked against that channel's rules. ${comingSoonFilesSentence()}`.trim(),
  linkLabel: "Read the rules",
};

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One tile per channel a pack makes files for, linking to its requirements page. */
export const homeChannelTiles = liveChannels().map((channel) => ({
  name: channel.name,
  files: capitalize(joinList(channel.files)),
  specId: channel.firstSpecId,
}));

export const homePricing = {
  title: "Simple credit pricing",
  freeTitle: "Free",
  freeBody: `${freeCredits()} credits once, ${freeCreditsReach()}.`,
  noCard: "No card needed.",
  unusedCredits: UNUSED_CREDITS_SENTENCE,
  fullPricing: "See full pricing",
};

export const homeFaqAside = {
  title: "Questions, answered",
  body: "Something else? The help center has more answers.",
  link: "Visit the help center",
};

export const homeGuides = {
  eyebrow: "Learn the rules",
  title: "Guides and free tools",
  readGuide: "Read the guide",
  toolsTitle: "Free tools",
};

/** The free browser tools. They need no account. */
export const homeTools = [
  {
    href: "/tools/main-image-checker",
    name: "Amazon Main Image Checker",
    body: "Measure your main image against the Amazon rules in your browser.",
  },
  {
    href: "/tools/white-background-fixer",
    name: "White Background Fixer",
    body: "Turn a light gray background pure white and see the difference.",
  },
  {
    href: "/tools/marketplace-resizer",
    name: "Marketplace Resizer",
    body: "Resize one photo for each channel, with white padding, in your browser.",
  },
];

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
    body: "Never redrawn by AI. Curvi cuts out your real product and builds the scene around it, then measures the color inside your product on every file.",
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
    body: `Files for ${joinList(liveChannelNames())}, each at the right size for its channel. ${comingSoonFilesSentence()}`.trim(),
    status: "live",
  },
  {
    key: "brandKit",
    title: "Brand kit",
    body: "Save your brand kit once. Packs use your first color for the brand color background, your fonts and logo on infographic and social images, and your style preset for lifestyle scenes.",
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
  answerFaqs.willAiChangeProduct,
  answerFaqs.bestAmazonTool,
  answerFaqs.amazonWhiteBackground,
  answerFaqs.generatorsVsPhotoTools,
  {
    q: "What do I need to start?",
    a: "One photo per product. A phone photo on a table works. Higher resolution photos give the pack more room for large formats.",
  },
  {
    q: "Which channels are covered?",
    a: `Curvi makes ${liveFilesPhrase()}. You pick the channels for each pack. ${comingSoonFilesSentence(["video formats"])}`,
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

/** The line under the closing email form; the link text is the middle part. */
export const homeClosingAlt = {
  before: "Or",
  link: "test your main image free",
  after: ", no account needed.",
};

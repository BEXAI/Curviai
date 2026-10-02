import { extraHelpArticles } from "./help-extra-articles";
import { QC_THRESHOLDS } from "@curvi/pipeline/qc-thresholds";
import { creditCosts } from "@curvi/pipeline/seed";
import { CODEX_KEY_ENV, codexConfigToml } from "@/lib/agent-setup";
import { isCheckoutOpen } from "@/lib/env";
import {
  amazonMainRules,
  annualSavingsPhrase,
  comingSoonFilesSentence,
  formatCredits,
  freeCredits,
  isLive,
  liveFilesPhrase,
  plansWithPhrase,
  typicalPackCredits,
  CREDIT_TERMS_SENTENCE,
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
  group?: "Making packs" | "Selling channels" | "Billing and account";
  sources?: Array<{ label: string; url: string }>;
  slug: string;
  title: string;
  body: string[];
  /** A code block shown after the body, built when the page renders. */
  snippet?: "codex_config";
  status?: "coming_soon";
  structured: "always" | "when_purchasable" | "never";
}

const main = amazonMainRules();

/** The help article on the API, MCP server, CLI and skill; llms.txt links it. */
export const AGENT_HELP_SLUG = "ai-agents-and-the-command-line";

/**
 * The help article on Curvi in ChatGPT and Codex (PHASE_19 P19-24). The MCP
 * server's protected resource metadata names it as resource_documentation,
 * so the slug never changes.
 */
export const CHATGPT_HELP_SLUG = "use-curvi-in-chatgpt";

/**
 * Curvi's listing in OpenAI's plugin directory. Null until the plugin is
 * published; set it together with the FEATURES.chatgptPlugin flip (PHASE_19
 * runbook E8), and the help article and llms.txt link it.
 */
export const CHATGPT_LISTING_URL: string | null = null;

/** The flags the agent and ChatGPT articles are worded from. */
export interface AgentFlags {
  agentApi: boolean;
  agentSkill: boolean;
  chatgptPlugin: boolean;
}

export function currentAgentFlags(): AgentFlags {
  return { agentApi: isLive("agentApi"), agentSkill: isLive("agentSkill"), chatgptPlugin: isLive("chatgptPlugin") };
}

/**
 * The API, MCP server, CLI and skill article. While the API is coming soon
 * the whole article is; once it is live the article answers for the API and
 * the MCP server and says which of the CLI, the skill and ChatGPT are still
 * coming soon.
 */
export function agentHelpArticle(flags: AgentFlags, listingUrl: string | null = CHATGPT_LISTING_URL): HelpArticle {
  if (!flags.agentApi) {
    return {
      slug: AGENT_HELP_SLUG,
      title: "Can I make packs from an AI agent or the command line?",
      status: "coming_soon",
      body: [
        "Not yet. A public Curvi API, an MCP server for AI assistants, a curvi command line tool and a Curvi skill for AI coding agents are coming soon. Each will make the same packs as the app, with the same checks, the same compliance report and the same credits.",
        "Access will use API keys you make and revoke in your workspace settings. Until then, make packs at the New pack page in the app, and use the free Amazon main image checker in the browser.",
      ],
      structured: "never",
    };
  }
  return {
    slug: AGENT_HELP_SLUG,
    title: flags.agentSkill
      ? "Can I make packs from an AI agent or the command line?"
      : "Can I make packs from an AI agent?",
    body: [
      `Yes. The Curvi API and the Curvi MCP server make the same packs as the app, with the same checks, the same compliance report and the same credits. Both use API keys, which workspace owners and admins make and revoke in Settings, API keys, on ${plansWithPhrase("apiAccess")}.`,
      "Send the key as a bearer token. The API keys page shows the address of the MCP server and links the API's OpenAPI document. Revoke a key there and every call made with it stops at once.",
      flags.agentSkill
        ? "The curvi command line tool and the Curvi skill for AI coding agents use the same keys."
        : "The curvi command line tool and a Curvi skill for AI coding agents are coming soon.",
      flags.chatgptPlugin
        ? `ChatGPT needs no key: you connect it with your Curvi account, as the article on using Curvi in ChatGPT explains.${listingUrl ? ` Curvi's listing is at ${listingUrl}.` : ""}`
        : "Connecting ChatGPT with your Curvi account instead of a key is coming soon.",
    ],
    structured: "always",
  };
}

/** The Codex paragraph both states of the ChatGPT article end with. */
function codexParagraph(flags: AgentFlags): string {
  return flags.agentApi
    ? `Codex can also reach Curvi with an API key, on ${plansWithPhrase("apiAccess")}. Make a key in Settings, API keys, set it as ${CODEX_KEY_ENV} in your environment, and add these lines to your Codex config.toml.`
    : "Using Curvi from Codex with an API key is coming soon.";
}

/**
 * Curvi in ChatGPT and Codex (PHASE_19 P19-24): connect, what it can do,
 * credits and disconnecting, plus Codex with an API key. Coming soon until
 * the plugin is published.
 */
export function chatgptHelpArticle(flags: AgentFlags, listingUrl: string | null = CHATGPT_LISTING_URL): HelpArticle {
  const codex = flags.agentApi ? ({ snippet: "codex_config" } as const) : {};
  if (!flags.chatgptPlugin) {
    return {
      slug: CHATGPT_HELP_SLUG,
      title: "Can I use Curvi in ChatGPT or Codex?",
      status: "coming_soon",
      body: [
        "Curvi in ChatGPT and Codex is coming soon. You will connect your Curvi account once, attach a product photo in the chat, and get finished images back with previews and download links.",
        `ChatGPT will tell you how many credits a pack needs before it starts, and packs will use your workspace's credits the same way as in the app. It will work on ${plansWithPhrase("assistantAccess")}.`,
        codexParagraph(flags),
      ],
      ...codex,
      structured: "never",
    };
  }
  return {
    slug: CHATGPT_HELP_SLUG,
    title: "Can I use Curvi in ChatGPT or Codex?",
    body: [
      `Yes. Find Curvi among the plugins in ChatGPT or Codex and connect it.${listingUrl ? ` Curvi's listing is at ${listingUrl}.` : ""} A Curvi page opens: sign in or create an account, pick the workspace ChatGPT should use if you have more than one, and press Connect. ChatGPT never sees your password.`,
      "Attach a product photo and say where you sell and what background you want. ChatGPT tells you how many credits the pack needs before the pack starts. Curvi changes only the background, size and surroundings and never redraws the product. When the pack is ready, each image comes with a preview, a download link and whether it passes its channel's checks. ChatGPT can also check a photo against Amazon's main image rules, which uses no credits.",
      `Packs made from ChatGPT use your workspace's credits the same way as in the app, and you are only charged for images that pass their checks. You can use it on ${plansWithPhrase("assistantAccess")}.`,
      "To stop ChatGPT from using your workspace, open Settings, Connected apps in Curvi and press Disconnect. Links ChatGPT already shared stop working, and ChatGPT asks you to connect again next time.",
      codexParagraph(flags),
    ],
    ...codex,
    structured: "always",
  };
}

/** The code block an article shows after its body, or null. */
export function articleSnippet(article: HelpArticle): string | null {
  return article.snippet === "codex_config" ? codexConfigToml() : null;
}

const agentFlags = currentAgentFlags();

export const helpArticles: HelpArticle[] = [
  ...extraHelpArticles,
  {
    slug: "what-photo-should-i-upload",
    title: "What photo should I upload?",
    body: [
      "One clear photo of your product is enough. Natural light, the whole product in frame, and as little blur as possible. A phone photo on a kitchen table works fine because Curvi rebuilds everything around the product.",
      `Higher resolution helps. If your photo's longest side is ${main.width} px or more, the pack can include full size marketplace images without upscaling. Avoid photos where part of the product is cut off, since Curvi never invents product pixels that were not in your photo.`,
      // P18-11, only while the urlImport flag says live.
      ...(isLive("urlImport")
        ? [
            "Already selling it? On the new pack page, paste the product's link from your Shopify store or from Amazon. Curvi fills in the name and notes and shows the listing's photos so you can pick the one to build from.",
          ]
        : []),
    ],
    structured: "always",
  },
  {
    slug: "how-credits-work",
    title: "How do credits work?",
    body: [
      `Every paid plan includes a monthly credit allowance, and the free plan gives you ${freeCredits()} credits once. A white background main image, a cutout, a resize or a background sweep costs ${formatCredits(creditCosts.deterministic)}. A generative lifestyle scene costs ${formatCredits(creditCosts.generativeStill)}.`,
      `A typical listing pack of still images uses about ${typicalPackCredits()} credits. You are only charged for files that pass their checks. ${CREDIT_TERMS_SENTENCE} That includes credits from top ups.`,
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
  agentHelpArticle(agentFlags),
  chatgptHelpArticle(agentFlags),
  {
    slug: "billing-and-cancellation",
    title: "How do billing and cancellation work?",
    body: [
      `Plans are monthly or annual, and annual costs ${annualSavingsPhrase()} less per month. You can cancel any time from the Billing page in the app with Cancel plan. Telling us why is optional, the Cancel my plan button stays beside any offer we show, and your plan stays active until the end of the period you paid for. No cancellation calls.`,
      `Top up credits you bought stay in your balance even if you cancel the subscription. ${CREDIT_TERMS_SENTENCE} The free plan needs no card at all.`,
    ],
    structured: "when_purchasable",
  },
];

/**
 * The AI labeling answer (docs/phases/PHASE_18.md P18-09 part 2), quoting
 * Google Merchant Center's accepted values (docs/verification.md, Google
 * Merchant IPTC row). It is held back until the founder's smoke:iptc run
 * shows compositeSynthetic on one delivered production lifestyle file, since
 * docs/marketing.md claim C-11 is gated on that run. In the change that
 * records the result, add it to helpArticles and add FEATURES.aiLabeling as
 * live. The claims test already checks its words.
 */
export const aiLabelingHelpArticle: HelpArticle = {
  slug: "are-ai-scenes-labeled",
  title: "Are scenes made with AI labeled?",
  body: [
    "Scenes made with AI around your real product carry the IPTC label Google Merchant Center accepts. Your main image carries no AI label, because nothing in it was generated.",
    "Google asks that images made with generative AI carry metadata saying so, and lists three IPTC DigitalSourceType values: TrainedAlgorithmicMedia, CompositeSynthetic and AlgorithmicMedia. Curvi writes CompositeSynthetic into every scene file, whether it is a JPEG, PNG or WebP. Google also asks that the tag is not removed, so upload each file as you downloaded it.",
    "Pictures on a share page are web copies without the tag. Give marketplaces the files you downloaded, never the share page copies.",
  ],
  structured: "always",
};

/** Articles that go into the FAQPage JSON-LD right now. */
export function structuredHelpArticles(): HelpArticle[] {
  const purchasable = isCheckoutOpen();
  return helpArticles.filter(
    (article) => article.structured === "always" || (article.structured === "when_purchasable" && purchasable),
  );
}

export const helpClosing = `Start free with ${freeCredits()} credits. No card needed.`;

/** The same gate controls the index, article URLs and sitemap. */
export function liveHelpArticles(): HelpArticle[] {
  return structuredHelpArticles().filter((article) => article.status !== "coming_soon");
}

/**
 * The companies that process data for Curvi (docs/phases/PHASE_20.md
 * P20-23), for the page /legal/subprocessors and the privacy policy.
 *
 * Each vendor lists its uses, and each use carries the check that puts it in
 * use: the same environment variables the code reads before it sends that
 * vendor anything. So the page lists a vendor, and says what it receives,
 * exactly when this deployment uses it. Turnstile turns on with P20-29's
 * site key and Upstash with P20-51's credentials, for example, with no code
 * change here. Vendors whose use is always on (hosting, the database, the
 * domain and its inbound email) say so.
 *
 * A test checks that every provider in DEFAULT_PROVIDER_ENTRIES and every
 * service in the health report (lib/health.ts) belongs to exactly one entry,
 * so a new provider cannot reach production without a line here.
 *
 * Connected services (role "connected") are the seller's own accounts that
 * they choose to link, such as a Shopify store. They are not processors
 * working for Curvi, so the page lists them apart.
 *
 * The pages read the build's environment, like every other marketing page
 * (lib/env.ts reads at call time). Adding or rewording an entry changes what
 * the page says, so move subprocessorsLastUpdated in lib/legal/facts.ts.
 */

import { DEFAULT_OPENAI_ADS_PIXEL_ID } from "@/lib/consent";
import { isLive } from "@/lib/marketing-facts";

/** The environment the checks read; process.env on the server. */
export type LegalEnv = Readonly<Record<string, string | undefined>>;

function has(env: LegalEnv, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0;
}

const always = (): boolean => true;

export interface VendorUse {
  /** What the vendor does for Curvi, one sentence. */
  purpose: string;
  /** What data it receives for this use, one sentence. */
  receives: string;
  /** For the founder: what turns this use on, and the item that ships it. */
  condition: string;
  /** True when this deployment uses the vendor this way. */
  inUse: (env: LegalEnv) => boolean;
}

export interface Vendor {
  key: string;
  name: string;
  role: "subprocessor" | "connected";
  uses: readonly VendorUse[];
  /** Provider and service names in lib/health.ts this vendor covers. */
  healthNames: readonly string[];
}

const IMAGE_MODEL_RECEIVES = "Images of your product and the scene instructions we write.";

export const VENDORS: readonly Vendor[] = [
  {
    key: "supabase",
    name: "Supabase",
    role: "subprocessor",
    healthNames: ["supabase", "database"],
    uses: [
      {
        purpose: "Runs our database and sign in.",
        receives: "Your account email and sign in details, and the records of your workspace, products, packs and credits.",
        condition: "Always: the app's database and Supabase Auth.",
        inUse: always,
      },
    ],
  },
  {
    key: "render",
    name: "Render",
    role: "subprocessor",
    healthNames: [],
    uses: [
      {
        purpose: "Hosts the website and the app, and runs your packs.",
        receives: "Everything the app handles while it runs, such as your photos while a pack is made, and our request logs.",
        condition: "Always: the web service runs on Render.",
        inUse: always,
      },
    ],
  },
  {
    key: "cloudflare",
    name: "Cloudflare",
    role: "subprocessor",
    healthNames: ["r2"],
    uses: [
      {
        purpose: "Runs our domain and forwards the email you send us.",
        receives: "The email you send us.",
        condition: "Always: DNS and Email Routing for curvi.ai.",
        inUse: always,
      },
      {
        purpose: "Stores your photos and pack files.",
        receives: "Your photos, cutouts and pack files.",
        condition: "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are set (R2 storage).",
        inUse: (env) => has(env, "R2_ACCOUNT_ID") && has(env, "R2_ACCESS_KEY_ID") && has(env, "R2_SECRET_ACCESS_KEY"),
      },
      {
        purpose: "Keeps encrypted copies of our database so we can recover it.",
        receives: "An encrypted copy of our database, which holds your account, workspace, credits and billing records.",
        condition: "Always: the nightly backup (P20-10) writes to its own R2 bucket from a separate cron service.",
        inUse: always,
      },
      {
        purpose: "Checks that sign ins and free tools are used by people, not bots.",
        receives: "Signals from your browser that tell people from bots.",
        condition: "NEXT_PUBLIC_TURNSTILE_SITE_KEY is set (Turnstile, P20-29).",
        inUse: (env) => has(env, "NEXT_PUBLIC_TURNSTILE_SITE_KEY"),
      },
    ],
  },
  {
    key: "stripe",
    name: "Stripe",
    role: "subprocessor",
    healthNames: ["stripe"],
    uses: [
      {
        purpose: "Takes card payments and keeps our billing records.",
        receives: "Your name, email address, card and billing address, and what you buy.",
        condition: "STRIPE_SECRET_KEY is set.",
        inUse: (env) => has(env, "STRIPE_SECRET_KEY"),
      },
    ],
  },
  {
    key: "resend",
    name: "Resend",
    role: "subprocessor",
    healthNames: [],
    uses: [
      {
        purpose: "Sends email for Curvi.",
        receives: "The address an email goes to and what it says.",
        condition: "RESEND_API_KEY is set.",
        inUse: (env) => has(env, "RESEND_API_KEY"),
      },
    ],
  },
  {
    key: "posthog",
    name: "PostHog",
    role: "subprocessor",
    healthNames: [],
    uses: [
      {
        purpose: "Shows us which pages help sellers, only if you accept analytics cookies.",
        receives: "The pages you open, what you click, and your device and browser details.",
        condition: "NEXT_PUBLIC_POSTHOG_KEY is set; it loads only after the visitor accepts cookies.",
        inUse: (env) => has(env, "NEXT_PUBLIC_POSTHOG_KEY"),
      },
    ],
  },
  {
    key: "sentry",
    name: "Sentry",
    role: "subprocessor",
    healthNames: [],
    uses: [
      {
        purpose: "Collects reports of errors on our servers so we can fix them.",
        receives: "Technical details of each error, such as the page and the code that failed.",
        condition: "SENTRY_DSN or NEXT_PUBLIC_SENTRY_DSN is set (P20-13).",
        inUse: (env) => has(env, "SENTRY_DSN") || has(env, "NEXT_PUBLIC_SENTRY_DSN"),
      },
    ],
  },
  {
    key: "openai",
    name: "OpenAI",
    role: "subprocessor",
    healthNames: ["openai-llm", "openai-image"],
    uses: [
      {
        purpose: "Runs the text models that read your photos and plan your packs, and generates scene images.",
        receives: "Your photos, product details and notes, and the scene instructions we write.",
        condition: "OPENAI_API_KEY is set.",
        inUse: (env) => has(env, "OPENAI_API_KEY"),
      },
      {
        purpose: "Measures which ads bring sellers to Curvi, only if you accept cookies.",
        receives: "The pages you open here and whether you sign up, only if you accept cookies.",
        condition:
          "The OpenAI Ads pixel is on unless NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID is set to an empty string (lib/consent.ts); it loads only after the visitor accepts cookies.",
        inUse: (env) => (env.NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID ?? DEFAULT_OPENAI_ADS_PIXEL_ID).trim().length > 0,
      },
    ],
  },
  {
    key: "anthropic",
    name: "Anthropic",
    role: "subprocessor",
    healthNames: ["anthropic"],
    uses: [
      {
        purpose: "Runs text models that read your photos and plan your packs.",
        receives: "Your photos, product details and notes.",
        condition: "ANTHROPIC_API_KEY is set (Claude is in every recipe chain).",
        inUse: (env) => has(env, "ANTHROPIC_API_KEY"),
      },
    ],
  },
  {
    key: "google",
    name: "Google (Gemini API)",
    role: "subprocessor",
    healthNames: ["gemini-image"],
    uses: [
      {
        purpose: "Generates scene images.",
        receives: IMAGE_MODEL_RECEIVES,
        condition: "GEMINI_API_KEY is set.",
        inUse: (env) => has(env, "GEMINI_API_KEY"),
      },
    ],
  },
  {
    key: "bfl",
    name: "Black Forest Labs",
    role: "subprocessor",
    healthNames: ["bfl-flux"],
    uses: [
      {
        purpose: "Generates scene images.",
        receives: IMAGE_MODEL_RECEIVES,
        condition: "BFL_API_KEY is set.",
        inUse: (env) => has(env, "BFL_API_KEY"),
      },
    ],
  },
  {
    key: "fal",
    name: "fal",
    role: "subprocessor",
    healthNames: ["fal-gateway", "fal-birefnet", "fal-birefnet-backup"],
    uses: [
      {
        purpose: "Cuts your product out of its photo.",
        receives: "Your product photos.",
        condition: "FAL_KEY or FAL_KEY_BACKUP is set.",
        inUse: (env) => has(env, "FAL_KEY") || has(env, "FAL_KEY_BACKUP"),
      },
    ],
  },
  {
    key: "upstash",
    name: "Upstash",
    role: "subprocessor",
    healthNames: [],
    uses: [
      {
        purpose: "Keeps shared counters that limit how often pages and tools can be used.",
        receives: "Your IP address or account id, with a count of your recent requests.",
        condition: "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set (P20-51).",
        inUse: (env) => has(env, "UPSTASH_REDIS_REST_URL") && has(env, "UPSTASH_REDIS_REST_TOKEN"),
      },
    ],
  },
  {
    key: "shopify",
    name: "Shopify",
    role: "connected",
    healthNames: ["shopify"],
    uses: [
      {
        purpose: "Sends Curvi the new products in your store, once you connect it.",
        receives: "The images you choose to send to your store.",
        condition:
          "SHOPIFY_API_SECRET is set and the Shopify app is live (FEATURES shopifyAutoPacks or directPublishing in lib/marketing-facts.ts).",
        inUse: (env) => has(env, "SHOPIFY_API_SECRET") && (isLive("shopifyAutoPacks") || isLive("directPublishing")),
      },
    ],
  },
];

/** A vendor as one row of the page: only the uses this deployment has on. */
export interface VendorInUse {
  key: string;
  name: string;
  role: Vendor["role"];
  purposes: string[];
  receives: string[];
}

/** The vendors this deployment uses, in page order, each with its uses in effect. */
export function vendorsInUse(env: LegalEnv = process.env): VendorInUse[] {
  return VENDORS.flatMap((vendor) => {
    const on = vendor.uses.filter((use) => use.inUse(env));
    return on.length === 0
      ? []
      : [
          {
            key: vendor.key,
            name: vendor.name,
            role: vendor.role,
            purposes: on.map((use) => use.purpose),
            receives: [...new Set(on.map((use) => use.receives))],
          },
        ];
  });
}

/** Subprocessors in use, for the main table and the privacy policy's list. */
export function subprocessorsInUse(env: LegalEnv = process.env): VendorInUse[] {
  return vendorsInUse(env).filter((vendor) => vendor.role === "subprocessor");
}

/** Services the seller connects themselves, in use in this deployment. */
export function connectedServicesInUse(env: LegalEnv = process.env): VendorInUse[] {
  return vendorsInUse(env).filter((vendor) => vendor.role === "connected");
}

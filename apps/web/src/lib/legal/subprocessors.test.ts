import { describe, expect, it } from "vitest";
import type { CircuitBreaker } from "@curvi/ai";
import { rule9Problems } from "@curvi/pipeline";
import { DEFAULT_PROVIDER_ENTRIES, HealthRegistry } from "@/lib/health";
import { unqualifiedClaims } from "@/lib/marketing-facts";
import {
  connectedServicesInUse,
  subprocessorsInUse,
  VENDORS,
  vendorsInUse,
  type LegalEnv,
} from "./subprocessors";

// docs/phases/PHASE_20.md P20-23: the subprocessor list covers every
// provider and service the health report knows, and lists a vendor exactly
// when this deployment uses it.

/** Every environment variable set, so every use whose check reads only env is on. */
const ALL_ON: LegalEnv = new Proxy({}, { get: () => "set" });

const NOTHING: LegalEnv = { NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID: "" };

async function healthServiceNames(): Promise<string[]> {
  const breaker = { isOpen: async () => false } as unknown as CircuitBreaker;
  const report = await new HealthRegistry([], breaker, () => undefined).report("demo");
  return report.services.map((service) => service.name);
}

function keys(list: { key: string }[]): string[] {
  return list.map((vendor) => vendor.key);
}

describe("coverage", () => {
  it("lists every provider and every health service in exactly one entry", async () => {
    const names = [...DEFAULT_PROVIDER_ENTRIES.map((entry) => entry.name), ...(await healthServiceNames())];
    expect(names.length).toBeGreaterThan(5);
    for (const name of new Set(names)) {
      const owners = VENDORS.filter((vendor) => vendor.healthNames.includes(name)).map((vendor) => vendor.key);
      expect(owners, `${name} needs exactly one entry in lib/legal/subprocessors.ts`).toHaveLength(1);
    }
  });

  it("names no provider or service the health report does not know", async () => {
    const known = new Set([...DEFAULT_PROVIDER_ENTRIES.map((entry) => entry.name), ...(await healthServiceNames())]);
    for (const vendor of VENDORS) {
      for (const name of vendor.healthNames) {
        expect(known.has(name), `${vendor.key} lists ${name}`).toBe(true);
      }
    }
  });

  it("carries every vendor the plan names, once each", () => {
    expect(keys([...VENDORS]).sort()).toEqual(
      [
        "anthropic",
        "bfl",
        "cloudflare",
        "fal",
        "google",
        "openai",
        "posthog",
        "render",
        "resend",
        "sentry",
        "shopify",
        "stripe",
        "supabase",
        "upstash",
      ].sort(),
    );
    const cloudflare = VENDORS.find((vendor) => vendor.key === "cloudflare");
    expect(cloudflare?.uses.map((use) => use.condition).join(" ")).toMatch(/Email Routing[\s\S]*R2[\s\S]*Turnstile/);
  });

  it("gives every use a purpose, what it receives and the condition that turns it on", () => {
    for (const vendor of VENDORS) {
      expect(vendor.uses.length).toBeGreaterThan(0);
      for (const use of vendor.uses) {
        expect(use.purpose.length).toBeGreaterThan(10);
        expect(use.receives.length).toBeGreaterThan(5);
        expect(use.condition.length).toBeGreaterThan(5);
      }
    }
  });
});

describe("in use conditions", () => {
  it("lists only hosting, the database and the domain with nothing configured", () => {
    expect(keys(subprocessorsInUse(NOTHING))).toEqual(["supabase", "render", "cloudflare"]);
    // The nightly backup runs on its own cron service, whose R2 variables
    // the web service never sees, so it is listed always (law and copy
    // review 15).
    expect(subprocessorsInUse(NOTHING).find((vendor) => vendor.key === "cloudflare")?.purposes).toEqual([
      "Runs our domain and forwards the email you send us.",
      "Keeps encrypted copies of our database so we can recover it.",
    ]);
    expect(connectedServicesInUse(NOTHING)).toEqual([]);
  });

  it("lists every subprocessor with everything configured, and Shopify only once its app is live", () => {
    expect(keys(subprocessorsInUse(ALL_ON))).toEqual(
      VENDORS.filter((vendor) => vendor.role === "subprocessor").map((vendor) => vendor.key),
    );
    // The Shopify app is coming soon (FEATURES), so a set secret alone does not list it.
    expect(connectedServicesInUse(ALL_ON)).toEqual([]);
  });

  it("turns Turnstile on with P20-29's site key", () => {
    const off = subprocessorsInUse({ ...NOTHING }).find((vendor) => vendor.key === "cloudflare");
    const on = subprocessorsInUse({ ...NOTHING, NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA" }).find(
      (vendor) => vendor.key === "cloudflare",
    );
    expect(off?.purposes.join(" ")).not.toMatch(/bots/);
    expect(on?.purposes.join(" ")).toMatch(/not bots/);
  });

  it("turns Upstash on only with both of P20-51's credentials", () => {
    expect(keys(subprocessorsInUse({ ...NOTHING, UPSTASH_REDIS_REST_URL: "https://x.upstash.io" }))).not.toContain(
      "upstash",
    );
    expect(
      keys(subprocessorsInUse({ ...NOTHING, UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" })),
    ).toContain("upstash");
  });

  it("needs all three R2 variables for storage, as isR2Configured does", () => {
    const partial = { ...NOTHING, R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "b" };
    const full = { ...partial, R2_SECRET_ACCESS_KEY: "c" };
    const purposes = (env: LegalEnv) =>
      subprocessorsInUse(env).find((vendor) => vendor.key === "cloudflare")?.purposes.join(" ") ?? "";
    expect(purposes(partial)).not.toMatch(/Stores your photos/);
    expect(purposes(full)).toMatch(/Stores your photos/);
  });

  it("follows each provider key, with fal on either account and Sentry on either DSN", () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["stripe", { STRIPE_SECRET_KEY: "sk_test_x" }],
      ["resend", { RESEND_API_KEY: "re_x" }],
      ["posthog", { NEXT_PUBLIC_POSTHOG_KEY: "phc_x" }],
      ["sentry", { SENTRY_DSN: "https://x@o.ingest.sentry.io/1" }],
      ["sentry", { NEXT_PUBLIC_SENTRY_DSN: "https://x@o.ingest.sentry.io/1" }],
      ["openai", { OPENAI_API_KEY: "sk-x" }],
      ["anthropic", { ANTHROPIC_API_KEY: "sk-ant-x" }],
      ["google", { GEMINI_API_KEY: "g" }],
      ["bfl", { BFL_API_KEY: "b" }],
      ["fal", { FAL_KEY: "f" }],
      ["fal", { FAL_KEY_BACKUP: "f" }],
    ];
    for (const [vendor, env] of cases) {
      expect(keys(subprocessorsInUse({ ...NOTHING, ...env })), JSON.stringify(env)).toContain(vendor);
    }
    // Blank values count as unset, as optionalEnv treats them.
    expect(keys(subprocessorsInUse({ ...NOTHING, STRIPE_SECRET_KEY: "  " }))).not.toContain("stripe");
  });

  it("lists OpenAI for the Ads pixel unless the pixel is turned off", () => {
    const pixelOnly = vendorsInUse({}).find((vendor) => vendor.key === "openai");
    expect(pixelOnly?.purposes).toEqual(["Measures which ads bring sellers to Curvi, only if you accept cookies."]);
    expect(keys(subprocessorsInUse({ NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID: "" }))).not.toContain("openai");
    const both = vendorsInUse({ OPENAI_API_KEY: "sk-x" }).find((vendor) => vendor.key === "openai");
    expect(both?.purposes).toHaveLength(2);
  });
});

describe("copy rules", () => {
  it("keeps every name, purpose and receipt plain (rule 9) and sells nothing that is not live", () => {
    for (const vendor of VENDORS) {
      for (const text of [vendor.name, ...vendor.uses.flatMap((use) => [use.purpose, use.receives])]) {
        expect(rule9Problems(text), text).toEqual([]);
        expect(unqualifiedClaims(text), text).toEqual([]);
      }
    }
  });
});

/**
 * Injectable provider health registry. Reports which providers have
 * credentials configured and each circuit breaker's state, and which
 * services (Supabase, database, R2, Stripe, Shopify) are configured. GET
 * /api/health/providers returns the services part next to its key probes.
 */

import {
  ANTHROPIC_API_KEY_ENV,
  BFL_API_KEY_ENV,
  CircuitBreaker,
  FAL_API_KEY_ENV,
  GEMINI_API_KEY_ENV,
  OPENAI_API_KEY_ENV,
  processBreakerStore,
} from "@curvi/ai";
import { cutoutModelSeedRows } from "@curvi/pipeline/seed";
import { isR2Configured, isStripeConfigured, isSupabaseConfigured, optionalEnv } from "@/lib/env";

export interface HealthProviderEntry {
  /** Registry name, e.g. "anthropic". */
  name: string;
  kind: string;
  envVar: string;
}

export interface HealthProviderReport {
  name: string;
  kind: string;
  configured: boolean;
  breaker: "open" | "closed";
}

export interface HealthServiceReport {
  name: string;
  configured: boolean;
}

export interface HealthReport {
  mode: "demo" | "db";
  providers: HealthProviderReport[];
  services: HealthServiceReport[];
  generatedAt: string;
}

export const DEFAULT_PROVIDER_ENTRIES: HealthProviderEntry[] = [
  // Every recipe runs on OpenAI first with Claude last (PHASE_17), so either
  // key makes the text stages live.
  { name: "openai-llm", kind: "llm", envVar: OPENAI_API_KEY_ENV },
  { name: "anthropic", kind: "llm", envVar: ANTHROPIC_API_KEY_ENV },
  { name: "gemini-image", kind: "image", envVar: GEMINI_API_KEY_ENV },
  { name: "bfl-flux", kind: "image", envVar: BFL_API_KEY_ENV },
  { name: "openai-image", kind: "image", envVar: OPENAI_API_KEY_ENV },
  { name: "fal-gateway", kind: "video", envVar: FAL_API_KEY_ENV },
  // Cutouts run on fal (BiRefNet); FAL_KEY is the required cutout key.
  ...cutoutModelSeedRows.map((row) => ({ name: row.providerName, kind: "cutout", envVar: FAL_API_KEY_ENV })),
];

export class HealthRegistry {
  constructor(
    private readonly entries: HealthProviderEntry[],
    private readonly breaker: CircuitBreaker,
    private readonly readEnv: (name: string) => string | undefined = optionalEnv,
  ) {}

  async report(mode: "demo" | "db"): Promise<HealthReport> {
    const providers = await Promise.all(
      this.entries.map(async (entry) => ({
        name: entry.name,
        kind: entry.kind,
        configured: Boolean(this.readEnv(entry.envVar)),
        breaker: (await this.breaker.isOpen(entry.name)) ? ("open" as const) : ("closed" as const),
      })),
    );
    const services: HealthServiceReport[] = [
      { name: "supabase", configured: isSupabaseConfigured() },
      { name: "database", configured: Boolean(this.readEnv("DATABASE_URL")) },
      { name: "r2", configured: isR2Configured() },
      { name: "stripe", configured: isStripeConfigured() },
      { name: "shopify", configured: Boolean(this.readEnv("SHOPIFY_API_SECRET")) },
    ];
    return { mode, providers, services, generatedAt: new Date().toISOString() };
  }
}

const globalScope = globalThis as typeof globalThis & { __curviHealthRegistry?: HealthRegistry };

export function getHealthRegistry(): HealthRegistry {
  globalScope.__curviHealthRegistry ??= new HealthRegistry(
    DEFAULT_PROVIDER_ENTRIES,
    // The breaker state the pack runner in this process writes.
    new CircuitBreaker(processBreakerStore()),
  );
  return globalScope.__curviHealthRegistry;
}

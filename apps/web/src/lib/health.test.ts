import { describe, expect, it } from "vitest";
import { CircuitBreaker, InMemoryBreakerStore } from "@curvi/ai";
import { cutoutModelSeedRows } from "@curvi/pipeline/seed";
import { DEFAULT_PROVIDER_ENTRIES, HealthRegistry } from "./health";

function envOf(names: string[]): (name: string) => string | undefined {
  return (name) => (names.includes(name) ? `secret-${name}` : undefined);
}

async function llmEntries(names: string[]) {
  const registry = new HealthRegistry(DEFAULT_PROVIDER_ENTRIES, new CircuitBreaker(new InMemoryBreakerStore()), envOf(names));
  const report = await registry.report("demo");
  return report.providers.filter((provider) => provider.kind === "llm");
}

describe("DEFAULT_PROVIDER_ENTRIES (docs/phases/PHASE_17.md workstream 3)", () => {
  it("lists OpenAI and Anthropic as the LLM providers, each under its own key", () => {
    expect(DEFAULT_PROVIDER_ENTRIES.filter((entry) => entry.kind === "llm")).toEqual([
      { name: "openai-llm", kind: "llm", envVar: "OPENAI_API_KEY" },
      { name: "anthropic", kind: "llm", envVar: "ANTHROPIC_API_KEY" },
    ]);
  });

  it("lists each cutout row under the key env the seed gives it, so FAL_KEY_BACKUP is named", () => {
    expect(DEFAULT_PROVIDER_ENTRIES.filter((entry) => entry.kind === "cutout")).toEqual(
      cutoutModelSeedRows.map((row) => ({ name: row.providerName, kind: "cutout", envVar: row.keyEnv })),
    );
    expect(DEFAULT_PROVIDER_ENTRIES).toContainEqual({ name: "fal-birefnet-backup", kind: "cutout", envVar: "FAL_KEY_BACKUP" });
  });

  it.each([
    [[], false, false],
    [["OPENAI_API_KEY"], true, false],
    [["ANTHROPIC_API_KEY"], false, true],
    [["OPENAI_API_KEY", "ANTHROPIC_API_KEY"], true, true],
  ])("with keys %j reports openai-llm %s and anthropic %s, never a key value", async (names, openai, anthropic) => {
    const entries = await llmEntries(names);
    expect(entries).toEqual([
      { name: "openai-llm", kind: "llm", configured: openai, breaker: "closed" },
      { name: "anthropic", kind: "llm", configured: anthropic, breaker: "closed" },
    ]);
    expect(JSON.stringify(entries)).not.toContain("secret-");
  });
});

describe("HealthRegistry services", () => {
  it("reports each service by presence only, never a secret value", async () => {
    const registry = new HealthRegistry(
      DEFAULT_PROVIDER_ENTRIES,
      new CircuitBreaker(new InMemoryBreakerStore()),
      envOf(["DATABASE_URL", "SHOPIFY_API_SECRET"]),
    );
    const { services } = await registry.report("demo");
    expect(services.map((service) => service.name)).toEqual(
      expect.arrayContaining(["supabase", "database", "r2", "stripe", "shopify"]),
    );
    expect(services.find((service) => service.name === "database")?.configured).toBe(true);
    expect(services.find((service) => service.name === "shopify")?.configured).toBe(true);
    expect(JSON.stringify(services)).not.toContain("secret-");
  });
});

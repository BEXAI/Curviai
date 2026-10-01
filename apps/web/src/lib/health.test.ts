import { describe, expect, it } from "vitest";
import { CircuitBreaker, InMemoryBreakerStore } from "@curvi/ai";
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

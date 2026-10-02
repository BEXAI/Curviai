import { describe, expect, it } from "vitest";
import {
  DemoMetricsReader,
  composeDigest,
  type MonthlyMetrics,
} from "./digest";

const metrics: MonthlyMetrics = {
  month: "2026-09",
  mrrUsd: 12345.67,
  churnRate: 0.072,
  cogsUsd: 2210.4,
  grossMargin: 0.73,
};

describe("composeDigest", () => {
  it("includes MRR, churn, COGS and margin", () => {
    const email = composeDigest(metrics);
    expect(email.subject).toContain("2026-09");
    expect(email.text).toContain("MRR: $12,345.67");
    expect(email.text).toContain("Churn: 7.2%");
    expect(email.text).toContain("COGS: $2,210.40");
    expect(email.text).toContain("Gross margin: 73.0%");
    expect(email.text).not.toContain("demo numbers");
  });

  it("adds LLM spend per provider when the usage counters were read (PHASE_17 workstream 6)", () => {
    const email = composeDigest({
      ...metrics,
      llmSpend: {
        days: ["2026-09-24", "2026-09-30"],
        byFamily: {
          openai: { costMicros: 12_340_000, calls: 900, inputTokens: 4_000_000, cachedInputTokens: 1_000_000, reasoningTokens: 250_000 },
          anthropic: { costMicros: 1_500_000, calls: 12, inputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
        },
      },
    });
    expect(email.text).toContain("LLM spend by provider, 2026-09-24 to 2026-09-30 (UTC):");
    expect(email.text).toContain("OpenAI: $12.34 over 900 calls, 25.0% of input tokens cached, 250000 reasoning tokens");
    expect(email.text).toContain("Claude: $1.50 over 12 calls");
    expect(email.text.indexOf("Claude:")).toBeLessThan(email.text.indexOf("OpenAI:"));
    expect(composeDigest(metrics).text).not.toContain("LLM spend");
    expect(composeDigest({ ...metrics, llmSpend: { days: [], byFamily: {} } }).text).toContain("No LLM calls were recorded.");
  });

  it("flags demo numbers from the demo reader", async () => {
    const demo = await new DemoMetricsReader("2026-09").read();
    const email = composeDigest(demo);
    expect(demo.demo).toBe(true);
    expect(email.text).toContain("demo numbers");
  });
});

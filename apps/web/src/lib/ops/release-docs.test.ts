import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const read = (name: string) => readFileSync(new URL(`../../../../../docs/${name}`, import.meta.url), "utf8");

describe("current Phase 20 release instructions", () => {
  it("keeps portal switching and Stripe renewal emails off while documenting scheduled changes", () => {
    const stripe = read("STRIPE_SETUP.md");
    expect(stripe).toContain("Switch plan: off in the default configuration");
    expect(stripe).toContain('"Send emails about upcoming renewals" off');
    expect(stripe).toContain("/api/billing/schedule");
    expect(stripe).toContain("Keep current plan");
    expect(stripe).not.toContain("Until the P1 schedule ships");
    expect(stripe).not.toContain("is never changed online");
  });
  it("keeps required runbooks and current deployment policy together without blanket unbuilt claims", () => {
    for (const file of ["RUNBOOK", "ALERTS", "BACKUP_RESTORE", "DISASTER_RECOVERY", "STAGING"]) {
      expect(read(`ops/${file}.md`).length).toBeGreaterThan(100);
    }
    const pending = read("PENDING.md");
    expect(pending).not.toContain("Nothing in this file is built yet");
    expect(pending).not.toMatch(/Deploy the Trigger\.dev worker/);
    expect(pending).toContain("0044_disposable_domains");
    const runbook = read("ops/RUNBOOK.md");
    expect(runbook).toContain("preserves Render's auto-deploy trigger by default");
    expect(runbook).toContain("cannot retroactively gate it");
  });
});

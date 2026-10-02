import { describe, expect, it } from "vitest";
import { activeRecipeModels, llmModelRetirements, modelRetirementNotices } from "./monitoring";
import { recipeSeedRows } from "./recipes";

describe("model retirement metadata", () => {
  it("has dated primary sources and no active chain at its earliest bound as of the verified date", () => {
    const asOf = new Date("2026-10-02T00:00:00Z");
    const active = activeRecipeModels(recipeSeedRows);
    expect(new Set(llmModelRetirements.map((row) => row.model)).size).toBe(llmModelRetirements.length);
    for (const retirement of llmModelRetirements) {
      expect(retirement.source).toMatch(/^https:\/\/platform\.claude\.com\//);
      expect(retirement.checkedOn).toBe("2026-10-02");
      expect(Number.isFinite(Date.parse(retirement.earliestRetirementDate))).toBe(true);
      if (active.has(retirement.model)) {
        expect(Date.parse(retirement.earliestRetirementDate), retirement.model).toBeGreaterThan(asOf.getTime());
      }
    }
    expect(active.has("claude-haiku-4-5-20251001")).toBe(false);
    expect(active.has("claude-opus-5-5")).toBe(true);
  });

  it("includes fallbacks and escalations of active rollback rows, excluding inactive drafts", () => {
    const models = activeRecipeModels([
      { active: true, model: "primary", fallbackModels: ["fallback"], body: { escalation: ["judge", 123, null] } },
      { active: false, model: "draft", fallbackModels: ["draft-fallback"], body: { escalation: ["draft-judge"] } },
    ]);
    expect([...models]).toEqual(["primary", "fallback", "judge"]);
  });

  it("warns at 30 days, degrades at 14, and keeps an elapsed earliest bound explicitly tentative", () => {
    const rows = [{ active: true, model: "claude-haiku-4-5-20251001" }];
    expect(modelRetirementNotices(rows, new Date("2026-09-14T23:59:59Z"))).toEqual([]);
    expect(modelRetirementNotices(rows, new Date("2026-09-15T23:59:59Z"))[0]).toMatchObject({ daysUntil: 30, severity: "info" });
    expect(modelRetirementNotices(rows, new Date("2026-10-01T23:59:59Z"))[0]).toMatchObject({ daysUntil: 14, severity: "degraded" });
    expect(modelRetirementNotices(rows, new Date("2026-10-05T00:00:00Z"))[0]).toMatchObject({ daysUntil: 10, severity: "degraded" });
    expect(modelRetirementNotices(rows, new Date("2026-10-16T00:00:00Z"))[0]).toMatchObject({ daysUntil: -1, severity: "degraded", dateKind: "not-sooner-than" });
  });
});

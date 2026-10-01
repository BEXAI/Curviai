import { describe, expect, it } from "vitest";
import { llmModelProviders } from "./models";
import { llmCreditWindows, llmFallbackAlertPolicy, llmQuotaAlertFamilies } from "./monitoring";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const families = new Set(Object.values(llmModelProviders));

describe("LLM monitoring seed (PHASE_17 workstream 6)", () => {
  it("seeds the founder's OpenAI credit expiry and both reminder dates", () => {
    const openai = llmCreditWindows.find((window) => window.family === "openai");
    expect(openai).toEqual({ family: "openai", expiresOn: "2026-12-31", reminderDates: ["2026-12-01", "2026-12-24"] });
  });

  it("keeps every credit window well formed: real days, reminders in order before the expiry", () => {
    for (const window of llmCreditWindows) {
      expect(families.has(window.family)).toBe(true);
      expect(window.expiresOn).toMatch(DAY);
      expect(Number.isNaN(Date.parse(`${window.expiresOn}T00:00:00Z`))).toBe(false);
      expect(window.reminderDates.length).toBeGreaterThan(0);
      for (const day of window.reminderDates) {
        expect(day).toMatch(DAY);
        expect(day < window.expiresOn).toBe(true);
      }
      expect([...window.reminderDates].sort()).toEqual(window.reminderDates);
    }
  });

  it("watches Claude fallbacks above 5 percent of OpenAI first calls", () => {
    expect(llmFallbackAlertPolicy.primaryFamily).toBe("openai");
    expect(llmFallbackAlertPolicy.fallbackFamily).toBe("anthropic");
    expect(llmFallbackAlertPolicy.maxFallbackShare).toBe(0.05);
    expect(llmFallbackAlertPolicy.minCallsPerHour).toBeGreaterThan(0);
    expect(llmQuotaAlertFamilies).toEqual(["openai"]);
    for (const family of llmQuotaAlertFamilies) expect(families.has(family)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { rule9Problems } from "@curvi/pipeline";
import { MCP_BANNED_WORDS, MCP_COPY, type McpCopyKey } from "./mcp-copy";

// The MCP copy table (PHASE_19 "Neutral messages"): plain spoken (rule 9),
// and nothing that sells a plan, asks for an API key or names a price.

const SAMPLE_ARGS: Partial<Record<McpCopyKey, unknown[]>> = {
  unknownChannels: [["myspace", "friendster"]],
  featureNotInPlan: ["Video"],
};

function lines(): Array<{ key: McpCopyKey; text: string }> {
  return (Object.keys(MCP_COPY) as McpCopyKey[]).map((key) => {
    const entry: unknown = MCP_COPY[key];
    if (typeof entry === "string") {
      return { key, text: entry };
    }
    const fn = entry as (...args: unknown[]) => string;
    const args = SAMPLE_ARGS[key] ?? Array.from({ length: fn.length }, (_, index) => 12 + index);
    return { key, text: fn(...args) };
  });
}

describe("MCP_COPY", () => {
  it("passes the rule 9 lint", () => {
    for (const { key, text } of lines()) {
      expect(rule9Problems(text), key).toEqual([]);
    }
  });

  it("never promotes a plan, a purchase or a price, and never asks for a key or a password", () => {
    for (const { key, text } of lines()) {
      const lower = text.toLowerCase();
      for (const word of MCP_BANNED_WORDS) {
        expect(lower.includes(word), `${key}: ${word}`).toBe(false);
      }
      expect(/\bfree\b|\bprice|password|send your .*key/i.test(text), key).toBe(false);
    }
  });

  it("fills its slots", () => {
    expect(MCP_COPY.insufficientCredits(9, 4)).toBe(
      "This pack needs 9 credits and the workspace has 4, so it was not started. Pick fewer channels or a smaller set.",
    );
    expect(MCP_COPY.unknownChannels(["myspace"])).toBe(
      "Curvi does not know myspace. Call list_channels to see the channels it makes.",
    );
  });

  it("says 1 credit, 1 image, 1 hour and 1 minute, never \"1 credits\"", () => {
    expect(MCP_COPY.estimateReady(1, 592)).toBe("This pack needs 1 credit and the workspace has 592.");
    expect(MCP_COPY.estimateShort(1, 0)).toBe(
      "This pack needs 1 credit and the workspace has 0, so it cannot start. Pick fewer channels or a smaller set.",
    );
    expect(MCP_COPY.insufficientCredits(1, 0)).toContain("needs 1 credit and");
    expect(MCP_COPY.overMaxCredits(1, 0)).toContain("needs 1 credit, more than");
    expect(MCP_COPY.packStarted(1)).toBe(
      "Started a pack that holds 1 credit. You are charged only for images that pass their checks.",
    );
    expect(MCP_COPY.packReady(1, 1)).toBe("The pack is ready: 1 of 1 image passed its channel check.");
    expect(MCP_COPY.packReady(0, 1)).toBe("The pack is ready: 0 of 1 image passed its channel check.");
    expect(MCP_COPY.packReady(2, 3)).toBe("The pack is ready: 2 of 3 images passed their channel checks.");
    expect(MCP_COPY.packWorking(0, 1)).toBe("Curvi is making the images: 0 of 1 is ready.");
    expect(MCP_COPY.packWorking(1, 3)).toBe("Curvi is making the images: 1 of 3 are ready.");
    expect(MCP_COPY.linksValid(60)).toBe("The links work for 1 hour.");
    expect(MCP_COPY.linksValid(1440)).toBe("The links work for 24 hours.");
    expect(MCP_COPY.linksValid(15)).toBe("The links work for 15 minutes.");
    expect(MCP_COPY.linksValid(1)).toBe("The links work for 1 minute.");
    for (const { key, text } of lines()) {
      expect(text, key).not.toMatch(/\b1 (credits|images|hours|minutes)\b/);
    }
    // And with every count at 1.
    for (const key of Object.keys(MCP_COPY) as McpCopyKey[]) {
      const entry: unknown = MCP_COPY[key];
      if (typeof entry === "function" && !SAMPLE_ARGS[key]) {
        const fn = entry as (...args: number[]) => string;
        expect(fn(...Array.from({ length: fn.length }, () => 1)), key).not.toMatch(/\b1 (credits|images|hours|minutes)\b/);
      }
    }
  });
});

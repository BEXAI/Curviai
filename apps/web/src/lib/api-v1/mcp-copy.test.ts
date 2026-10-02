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
});

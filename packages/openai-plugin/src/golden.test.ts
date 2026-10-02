import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rule9Problems } from "@curvi/pipeline/copy-lint";
import { MCP_COPY } from "@/lib/api-v1/mcp-copy";
import { toolsTriggered, PLUGIN_DIR } from "./manifest";

// The golden prompt set for the manual developer mode runs (docs/phases/
// PHASE_19.md, P19-26; O7 and O12 ask for direct, indirect and negative
// prompts): it holds the review cases word for word, 10 more phrasings and
// the prohibited goods negatives (P19-29).

interface GoldenPrompt {
  id: string;
  kind: "review_positive" | "review_negative" | "phrasing" | "prohibited";
  prompt: string;
  attachment: string | null;
  tools: string[];
  expected: string;
  needs?: string;
}

const FIXTURE = fileURLToPath(new URL("../fixtures/golden-prompts.json", import.meta.url));
const golden = JSON.parse(readFileSync(FIXTURE, "utf8")) as { sample_photo: string; prompts: GoldenPrompt[] };
const plugin = JSON.parse(readFileSync(join(PLUGIN_DIR, "plugin.json"), "utf8")) as {
  extensions: {
    "com.openai": {
      review: {
        test_cases: {
          positive: Array<{ prompt: string; tools_triggered: string; expected_behavior: string; file_attachment_urls?: string[] }>;
          negative: Array<{ prompt: string; description: string }>;
        };
      };
    };
  };
};
const cases = plugin.extensions["com.openai"].review.test_cases;

/** The tools the MCP server offers an OAuth caller (PHASE_19 "Tools"). */
const TOOLS = ["list_channels", "estimate_pack", "create_pack", "get_pack", "show_pack", "check_main_image", "get_profile"];

describe("golden prompts", () => {
  it("hold every review case word for word, with its tools and expected behavior", () => {
    const positives = golden.prompts.filter((entry) => entry.kind === "review_positive");
    expect(positives.map((entry) => entry.prompt)).toEqual(cases.positive.map((entry) => entry.prompt));
    positives.forEach((entry, index) => {
      const review = cases.positive[index]!;
      expect(entry.tools).toEqual(toolsTriggered(review.tools_triggered));
      expect(entry.expected).toBe(review.expected_behavior);
      expect(entry.attachment === "sample_photo").toBe((review.file_attachment_urls ?? []).includes(golden.sample_photo));
    });
    const negatives = golden.prompts.filter((entry) => entry.kind === "review_negative");
    expect(negatives.map((entry) => entry.prompt)).toEqual(cases.negative.map((entry) => entry.prompt));
    negatives.forEach((entry, index) => {
      expect(entry.tools).toEqual([]);
      expect(entry.expected).toBe(cases.negative[index]!.description);
    });
  });

  it("add 10 more phrasings and the vape and pepper spray negatives", () => {
    expect(golden.prompts.filter((entry) => entry.kind === "phrasing")).toHaveLength(10);
    const prohibited = golden.prompts.filter((entry) => entry.kind === "prohibited");
    expect(prohibited.map((entry) => entry.id)).toEqual(["prohibited-vape", "prohibited-pepper-spray"]);
    for (const entry of prohibited) {
      expect(entry.tools).toEqual([]);
      expect(entry.needs).toBe("P19-29");
      // The line the server sends when intake stops the pack (P19-29, job-copy).
      expect(entry.expected).toContain(MCP_COPY.restrictedProduct);
    }
  });

  it("name only tools the server offers, unique ids, and clean copy", () => {
    const ids = golden.prompts.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of golden.prompts) {
      expect(entry.tools.every((tool) => TOOLS.includes(tool)), entry.id).toBe(true);
      for (const text of [entry.prompt, entry.expected]) {
        expect(rule9Problems(text), `${entry.id}: ${text}`).toEqual([]);
      }
    }
    // Every tool is exercised by at least one prompt.
    expect([...new Set(golden.prompts.flatMap((entry) => entry.tools))].sort()).toEqual([...TOOLS].sort());
  });
});

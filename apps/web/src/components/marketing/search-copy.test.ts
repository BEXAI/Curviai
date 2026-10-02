import { describe, expect, it } from "vitest";
import { storeAudit } from "@curvi/pipeline/seed";
import { identityClaims, unqualifiedClaims } from "@/lib/marketing-facts";
import { checkerChannels } from "@/lib/tools/checker-rules";
import { checkerCopy, checkerRulesPhrase, orList, storeAuditCopy, storeAuditErrors } from "./search-copy";

// CLAUDE.md rule 9 for the search tools' copy (P18-10, P18-18): no emojis,
// no arrows, no dashes as punctuation, and nothing sold that does not run.
// The same pattern as claims.test.ts.
const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;

/** Every string the module can produce, with real channel names and rules. */
function allCopy(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  const add = (where: string, value: unknown) => {
    if (typeof value === "string") {
      out.push({ where, text: value });
    }
  };
  const channels = checkerChannels();
  for (const [key, value] of Object.entries(checkerCopy)) {
    if (typeof value === "function") {
      for (const channel of channels) {
        add(`checker ${key} ${channel.key}`, (value as (name: string, rules: typeof channel.rules) => string)(channel.name, channel.rules));
      }
    } else {
      add(`checker ${key}`, value);
    }
  }
  for (const channel of channels) {
    add(`rules phrase ${channel.key}`, checkerRulesPhrase(channel.rules));
  }
  const names = channels.map((channel) => channel.name);
  for (const [key, value] of Object.entries(storeAuditCopy)) {
    if (typeof value !== "function") {
      add(`audit ${key}`, value);
    }
  }
  add("audit intro", storeAuditCopy.intro(names));
  add("audit how", storeAuditCopy.how(storeAudit.maxProducts));
  add("audit summary", storeAuditCopy.summary(3, 25, names[0] ?? "", 1, storeAudit.thinImageCount));
  add("audit summary plural", storeAuditCopy.summary(0, 4, names[0] ?? "", 4, storeAudit.thinImageCount));
  add("audit summary none checked", storeAuditCopy.summary(0, 0, names[0] ?? "", 0, storeAudit.thinImageCount));
  add("checker link lead", `${storeAuditCopy.fromCheckerLead} ${storeAuditCopy.fromCheckerLink}.`);
  add("audit partial", storeAuditCopy.partial(1));
  add("audit partial plural", storeAuditCopy.partial(2));
  add("audit fail cell", storeAuditCopy.failCell(["Background at the edges is pure white", "Product fills too little"]));
  for (const [key, value] of Object.entries(storeAuditErrors)) {
    add(`audit error ${key}`, value);
  }
  return out;
}

describe("search tool copy", () => {
  it("has no emojis, arrows or dashes used as punctuation", () => {
    for (const { where, text } of allCopy()) {
      expect(text.match(FORBIDDEN_COPY)?.[0], where).toBeUndefined();
    }
  });

  it("sells nothing that is coming soon, and claims no product identity (P18-09)", () => {
    for (const { where, text } of allCopy()) {
      expect(unqualifiedClaims(text), where).toEqual([]);
      expect(identityClaims(text), where).toEqual([]);
    }
  });

  it("names only the channels the checker offers in the store audit intro", () => {
    const names = checkerChannels().map((channel) => channel.name);
    const intro = storeAuditCopy.intro(names);
    for (const name of names) {
      expect(intro).toContain(name);
    }
    if (!names.includes("Walmart")) {
      expect(intro).not.toContain("Walmart");
    }
  });

  it("states each channel's own numbers in the checker intro", () => {
    for (const channel of checkerChannels()) {
      const intro = checkerCopy.intro(channel.name, channel.rules);
      if (channel.rules.fillMinPercent !== null) {
        expect(intro).toContain(`${channel.rules.fillMinPercent} to ${channel.rules.fillMaxPercent} percent`);
      }
      expect(intro).toContain(channel.name);
    }
  });

  it("joins lists in plain words", () => {
    expect(orList(["Amazon"])).toBe("Amazon");
    expect(orList(["Amazon", "Google Merchant"])).toBe("Amazon or Google Merchant");
    expect(orList(["A", "B", "C"])).toBe("A, B or C");
  });
});

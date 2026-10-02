import { describe, expect, it } from "vitest";
import { bareAddress } from "./config";

describe("bareAddress linear sender parsing", () => {
  it.each([
    ["  seller@example.com  ", "seller@example.com"],
    ["Name <seller@example.com> ignored", "seller@example.com"],
    ["<not-an-address> Name <seller@example.com>", "seller@example.com"],
    ["<invalid@> <seller@example.com>", "seller@example.com"],
    ["<@invalid> <seller@example.com>", "seller@example.com"],
    ["<<seller@example.com>>", "seller@example.com"],
    ["<a@b@c> <seller@example.com>", null],
    ["<a,b@example.com> <seller@example.com>", null],
    ["<seller@localhost> <seller@example.com>", null],
    ["seller@.example", null],
    ["seller@example.", null],
    ["seller@..example", "seller@..example"],
    ["seller@example..", "seller@example.."],
    ["seller@a.b\n", "seller@a.b"],
    ["seller @example.com", null],
    [null, null],
  ])("preserves sender extraction for %j", (value, expected) => {
    expect(bareAddress(value)).toBe(expected);
  });

  it("handles long malformed bracketed tokens and dotted domains without backtracking", () => {
    const run = "a".repeat(200_000);
    expect(bareAddress(`<${run}@${run}`)).toBeNull();
    expect(bareAddress(`<${"@".repeat(200_000)}>`)).toBeNull();
    expect(bareAddress(`seller@${".".repeat(200_000)}!;`)).toBeNull();
    expect(bareAddress(`<${run}> <seller@example.com>`)).toBe("seller@example.com");
  });
});

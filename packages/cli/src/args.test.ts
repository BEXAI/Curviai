import { describe, expect, it } from "vitest";
import { listFlag, parseArgs, UsageError } from "./args.ts";

const SPECS = { channels: { multiple: true }, bundle: {}, wait: { boolean: true } };

describe("parseArgs", () => {
  it("reads positionals, values, = values and switches", () => {
    const args = parseArgs(["photo.jpg", "--channels", "amazon.main", "--bundle=listing", "--wait"], SPECS);
    expect(args.positionals).toEqual(["photo.jpg"]);
    expect(args.flags).toEqual({ channels: ["amazon.main"], bundle: "listing", wait: true });
  });

  it("collects a repeated flag and splits commas", () => {
    const args = parseArgs(["--channels", "amazon.main,shopify.product", "--channels", " etsy.listing "], SPECS);
    expect(listFlag(args, "channels")).toEqual(["amazon.main", "shopify.product", "etsy.listing"]);
  });

  it("treats everything after -- as positionals", () => {
    expect(parseArgs(["--", "--wait"], SPECS).positionals).toEqual(["--wait"]);
  });

  it("refuses unknown flags, missing values and values on switches", () => {
    expect(() => parseArgs(["--chanels", "x"], SPECS)).toThrow(UsageError);
    expect(() => parseArgs(["--bundle"], SPECS)).toThrow("The option --bundle needs a value.");
    expect(() => parseArgs(["--bundle="], SPECS)).toThrow(UsageError);
    expect(() => parseArgs(["--wait=yes"], SPECS)).toThrow("The option --wait takes no value.");
  });
});

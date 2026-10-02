import { describe, expect, it } from "vitest";
import { disposableDomainSeedSource } from "@curvi/pipeline/seed";
import { parseDisposableDomainSeed, readDisposableDomainSeed } from "./disposable-domains";

describe("vendored disposable domain seed", () => {
  it("matches the verified upstream digest and has unique normalized domains", () => {
    const domains = readDisposableDomainSeed();
    expect(domains).toHaveLength(disposableDomainSeedSource.domainCount);
    expect(domains).toEqual([...new Set(domains)].sort());
    expect(domains.every((domain) => domain === domain.trim().toLowerCase())).toBe(true);
    expect(disposableDomainSeedSource.license).toBe("CC0-1.0");
  });

  it("refuses an empty or changed list before the database loader can run", () => {
    expect(() => parseDisposableDomainSeed("")).toThrow(/digest/);
    expect(() => parseDisposableDomainSeed("forged.example\n")).toThrow(/digest/);
  });
});

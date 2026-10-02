import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { backup } from "@curvi/pipeline/seed";

// docs/phases/PHASE_20.md P20-10 and decision 12: the backup bucket's
// lifecycle and lock files say what the seed says, so the privacy page
// (which reads the seed) never states a window the bucket does not keep.

const DAY_SECONDS = 24 * 60 * 60;

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"));
}

interface LifecycleRule {
  ID: string;
  Status: string;
  Filter: { Prefix: string };
  Expiration?: { Days: number };
  AbortIncompleteMultipartUpload?: { DaysAfterInitiation: number };
}

interface LockRule {
  id: string;
  enabled: boolean;
  prefix: string;
  condition: { type: string; maxAgeSeconds?: number };
}

describe("ops/r2/backups-lifecycle.json", () => {
  const { Rules } = readJson("../../../ops/r2/backups-lifecycle.json") as { Rules: LifecycleRule[] };
  const byPrefix = (prefix: string) => Rules.filter((rule) => rule.Filter.Prefix === prefix);

  it("expires daily and monthly copies after the seeded days", () => {
    expect(byPrefix("daily/").map((rule) => rule.Expiration?.Days)).toEqual([backup.dailyKeepDays]);
    expect(byPrefix("monthly/").map((rule) => rule.Expiration?.Days)).toEqual([backup.monthlyKeepDays]);
  });

  it("aborts incomplete multipart uploads after the seeded days, bucket wide", () => {
    expect(byPrefix("").map((rule) => rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation)).toEqual([
      backup.abortMultipartDays,
    ]);
  });

  it("has only those three enabled rules with unique ids", () => {
    expect(Rules).toHaveLength(3);
    expect(Rules.every((rule) => rule.Status === "Enabled")).toBe(true);
    expect(new Set(Rules.map((rule) => rule.ID)).size).toBe(3);
  });
});

describe("ops/r2/backups-lock.json", () => {
  const { rules } = readJson("../../../ops/r2/backups-lock.json") as { rules: LockRule[] };

  it("locks only daily copies, by age, for the seeded days", () => {
    expect(rules).toEqual([
      {
        id: expect.any(String),
        enabled: true,
        prefix: "daily/",
        condition: { type: "Age", maxAgeSeconds: backup.lockDays * DAY_SECONDS },
      },
    ]);
  });
});

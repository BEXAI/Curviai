import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { describe, expect, it } from "vitest";
import * as schema from "./schema";
import { readJournalEntries } from "./test-helpers";

const metaDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "meta");

type Snapshot = Parameters<typeof generateMigration>[0];

/**
 * The newest drizzle snapshot must describe schema.ts exactly. When a
 * migration is edited in place on one branch while another branch adds the
 * next one (PHASE_19 0028 was generated from a 0027 that main later
 * changed), git merges the stale snapshot without a conflict and the next
 * `pnpm db:generate` writes a migration that drops columns that never existed.
 * This is the same comparison drizzle-kit generate makes, without writing.
 */
describe("drizzle snapshot drift", () => {
  it("the latest snapshot matches schema.ts, so db:generate has nothing to write", async () => {
    const entries = readJournalEntries();
    const latest = entries[entries.length - 1]!;
    const file = `${String(latest.idx).padStart(4, "0")}_snapshot.json`;
    const snapshot = JSON.parse(readFileSync(join(metaDir, file), "utf8")) as Snapshot;
    const current = generateDrizzleJson(schema as Record<string, unknown>, snapshot.id);
    const statements = await generateMigration(snapshot, current);
    expect(statements).toEqual([]);
  });
});

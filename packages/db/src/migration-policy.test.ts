import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIGRATION_POLICY_BASELINE, migrationPolicyIssues } from "./migration-policy";

describe("expand/contract migration policy", () => {
  it.each([
    "DROP TABLE products;", "ALTER TABLE products RENAME COLUMN name TO title;",
    "ALTER TABLE products ALTER COLUMN name TYPE text;", "DELETE FROM platform_settings WHERE key = 'ops:packs_paused';",
    'UPDATE public."platform_settings" SET value = false;',
    "DO $$ BEGIN EXECUTE 'DROP POLICY old ON products'; END $$;",
  ])("requires a statement-specific contract marker: %s", (source) => {
    expect(migrationPolicyIssues(source)).toHaveLength(1);
    expect(migrationPolicyIssues(`-- contract: approved after compatible readers shipped\n${source}`)).toEqual([]);
  });
  it("does not let a preceding statement's marker authorize the next one", () => {
    expect(migrationPolicyIssues("-- contract: retired table\nDROP TABLE old;\nDELETE FROM platform_settings;")).toEqual([{ statement: 2, operation: "DELETE FROM platform_settings" }]);
    expect(migrationPolicyIssues("-- DROP is mentioned in a note\nALTER TABLE products ADD COLUMN color text;" )).toEqual([]);
  });
  it("checks every migration after the immutable shipped baseline", () => {
    const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
    for (const name of readdirSync(dir).filter((name) => /^\d+_.*\.sql$/.test(name) && Number(name.split("_")[0]) > MIGRATION_POLICY_BASELINE)) {
      expect(migrationPolicyIssues(readFileSync(`${dir}/${name}`, "utf8")), name).toEqual([]);
    }
  });
});

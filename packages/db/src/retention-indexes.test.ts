import { describe, expect, it } from "vitest";
import { createTestDb } from "./test-helpers";

describe("retention_indexes", () => {
  it("adds age indexes for each unbounded retention scan", async () => {
    const { client } = await createTestDb();
    try {
      for (const [table, column] of [["events", "at"], ["spend_cap_counters", "updated_at"], ["upload_preflights", "updated_at"]]) {
        const rows = await client.query<{ indexdef: string }>("select indexdef from pg_indexes where schemaname = 'public' and indexname = $1", [`${table}_${column}_idx`]);
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0]?.indexdef).toContain(`(${column})`);
      }
    } finally {
      await client.close();
    }
  });
});

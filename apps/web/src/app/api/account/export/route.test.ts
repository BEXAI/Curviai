import { describe, expect, it } from "vitest";
import { GET } from "./route";

// With no env configured the app runs on the demo service, so the export
// route answers with the demo workspace's document.
describe("GET /api/account/export", () => {
  it("downloads the workspace's data as a named, uncached JSON attachment", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="curvi-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { format: string; notice: string; products: unknown[]; packs: unknown[] };
    expect(body.format).toBe("curvi-export-v1");
    expect(body.notice).toMatch(/24 hours/);
    expect(Array.isArray(body.products)).toBe(true);
    expect(Array.isArray(body.packs)).toBe(true);
  });
});

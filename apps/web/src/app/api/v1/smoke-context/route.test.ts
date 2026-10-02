import { beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
const auth = vi.hoisted(() => vi.fn());
const excluded = vi.hoisted(() => vi.fn());
const dbMode = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-v1/http", () => ({ authorize: auth }));
vi.mock("@/lib/customer-metrics", () => ({ operatorWorkspaceIds: excluded }));
vi.mock("@/lib/services", () => ({ isDbMode: dbMode }));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({}) }));
import { GET } from "./route";
const own = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const request = () => new Request("https://curvi.ai/api/v1/smoke-context");
beforeEach(() => { auth.mockReset().mockResolvedValue({ caller: { principal: { workspaceId: own } } }); excluded.mockReset(); dbMode.mockReset().mockReturnValue(true); });
it("requires API-key read authorization and returns only the caller's own proven workspace", async () => {
  excluded.mockResolvedValue([other, own]);
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ workspaceId: own, excluded: true });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(auth).toHaveBeenCalledWith(expect.any(Request), "packs:read");
});
it("fails closed for another operator workspace, unconfigured DB and unavailable telemetry", async () => {
  excluded.mockResolvedValue([other]);
  expect((await GET(request())).status).toBe(403);
  excluded.mockRejectedValue(new Error("database unavailable"));
  expect((await GET(request())).status).toBe(503);
  dbMode.mockReturnValue(false);
  expect((await GET(request())).status).toBe(503);
});
it("does not query operator membership before authorization succeeds", async () => {
  auth.mockResolvedValue({ response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) });
  expect((await GET(request())).status).toBe(401);
  expect(excluded).not.toHaveBeenCalled();
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "@/lib/services/types";
import { ProvisioningError } from "@/lib/services/errors";
import { createFakeServices, TEST_WORKSPACE_ID } from "@/lib/testing/fake-services";

// GET /api/account/export carries every photo and pack of the workspace, so
// only owners and admins may download it. Runs on the services builder.

let services: Services;

vi.mock("@/lib/services", () => ({
  getServices: () => services,
  isDbMode: () => false,
}));

const { GET } = await import("./route");

beforeEach(() => {
  services = createFakeServices("owner");
});

describe("GET /api/account/export access", () => {
  it.each(["owner", "admin"] as const)("lets an %s download an uncached export", async (role) => {
    services = createFakeServices(role);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(services.listProducts).toHaveBeenCalledWith(TEST_WORKSPACE_ID);
  });

  it.each(["editor", "client"] as const)("refuses an %s seat with 403 before building anything", async (role) => {
    services = createFakeServices(role);
    const response = await GET();
    expect(response.status).toBe(403);
    expect(services.listProducts).not.toHaveBeenCalled();
  });

  it("answers 401 when signed out", async () => {
    services = createFakeServices(null);
    expect((await GET()).status).toBe(401);
    expect(services.listProducts).not.toHaveBeenCalled();
  });

  it("answers a retryable 503 when the workspace could not be set up", async () => {
    vi.mocked(services.getCurrentWorkspace).mockRejectedValue(new ProvisioningError());
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBeTruthy();
  });

  it("answers 503 without the error text when the export cannot be built", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(services.listProducts).mockRejectedValue(new Error("connection to db-internal-7 refused"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("db-internal-7");
    spy.mockRestore();
  });
});

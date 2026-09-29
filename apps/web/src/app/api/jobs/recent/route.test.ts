import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "@/lib/services/types";
import { ProvisioningError } from "@/lib/services/errors";
import { createFakeServices, TEST_JOB_ID, TEST_WORKSPACE_ID } from "@/lib/testing/fake-services";

let services: Services;

vi.mock("@/lib/services", () => ({
  getServices: () => services,
  isDbMode: () => true,
}));

const { GET } = await import("./route");

beforeEach(() => {
  services = createFakeServices("owner");
});

describe("GET /api/jobs/recent", () => {
  it("lists the workspace's recent packs with only what the notice needs", async () => {
    vi.mocked(services.listRecentJobs).mockResolvedValue([
      { id: TEST_JOB_ID, productTitle: "Kettle", status: "generating", creditsReserved: 6, creditsCharged: 0, createdAt: new Date(0).toISOString() },
    ]);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ jobs: [{ id: TEST_JOB_ID, productTitle: "Kettle", status: "generating" }] });
    expect(services.listRecentJobs).toHaveBeenCalledWith(TEST_WORKSPACE_ID, 10);
  });

  it("answers 401 when signed out", async () => {
    services = createFakeServices(null);
    expect((await GET()).status).toBe(401);
    expect(services.listRecentJobs).not.toHaveBeenCalled();
  });

  it("answers a retryable 503 when the workspace could not be set up", async () => {
    vi.mocked(services.getCurrentWorkspace).mockRejectedValue(new ProvisioningError());
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBeTruthy();
  });
});

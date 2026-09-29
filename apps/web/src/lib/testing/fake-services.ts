/**
 * A controllable Services double for route handler tests. Each method is a
 * vi.fn so a test can assert what a route did or did not reach.
 */

import { vi } from "vitest";
import type { Services, WorkspaceRole, WorkspaceSummary } from "@/lib/services/types";

export const TEST_WORKSPACE_ID = "0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d";
export const OTHER_WORKSPACE_ID = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
export const TEST_PRODUCT_ID = "3f2e1d0c-9b8a-4765-8432-10fedcba9876";
export const TEST_JOB_ID = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";

export function workspaceFor(role: WorkspaceRole): WorkspaceSummary {
  return { id: TEST_WORKSPACE_ID, name: "Test", plan: "starter", creditBalance: 100, role };
}

/** Every method is a vi.fn; reach the mock API with vi.mocked(fake.method). */
export function createFakeServices(role: WorkspaceRole | null = "owner"): Services {
  const workspace = role ? workspaceFor(role) : null;
  return {
    mode: "db",
    getCurrentWorkspace: vi.fn(async () => workspace),
    ensureWorkspace: vi.fn(async () => workspace),
    renameWorkspace: vi.fn(async () => ({ ok: true, notice: "ok" })),
    listProducts: vi.fn(async () => []),
    listProductLibrary: vi.fn(async () => []),
    getProduct: vi.fn(async () => null),
    listRecentJobs: vi.fn(async () => []),
    getJob: vi.fn(async () => null),
    createJob: vi.fn(async () => ({ outcome: "conflict" as const })),
    cancelJob: vi.fn(async () => ({ outcome: "rejected" as const, reason: "not_found" as const, message: "Not found." })),
    retryShot: vi.fn(async () => ({ outcome: "rejected" as const, reason: "not_found" as const, message: "Not found." })),
    addShotPhoto: vi.fn(async () => ({ outcome: "rejected" as const, reason: "not_found" as const, message: "Not found." })),
    listJobFiles: vi.fn(async () => null),
    getJobFileDownload: vi.fn(async () => null),
    getComplianceReport: vi.fn(async () => null),
    createProduct: vi.fn(async (_ws, input) => ({
      id: TEST_PRODUCT_ID,
      title: input.title,
      mode: input.mode,
      category: "other",
      createdAt: new Date(0).toISOString(),
      sku: null,
      boxContents: [],
      comparisonFacts: [],
    })),
    registerSourceMedia: vi.fn(async () => ({ ok: true, notice: "Photo saved to this product." })),
    preflightUpload: vi.fn(async () => ({ ok: false as const, reason: "unavailable" as const, message: "Not configured." })),
    getBrandKit: vi.fn(async () => ({
      name: "Default",
      colors: [],
      fonts: { heading: "", body: "" },
      stylePreset: "minimal_studio",
      hasLogo: false,
    })),
    outputOptionsEnabled: vi.fn(async () => true),
    saveBrandKit: vi.fn(async () => ({ ok: true, notice: "Brand kit saved." })),
    listMembers: vi.fn(async () => []),
    listIntegrations: vi.fn(async () => []),
  };
}

export function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10", ...headers },
    body: JSON.stringify(body),
  });
}

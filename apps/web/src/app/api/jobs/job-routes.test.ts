import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobFileDownload, JobFilesView, SaveResult, WorkspaceSummary } from "@/lib/services/types";

// Route level behavior for the job file routes (Update.md 6.5, 6.6, 6.8 and
// 4.7 for the ids they own), with the service layer faked.

const JOB_ID = "00000000-0000-4000-8000-00000000a001";
const WORKSPACE: WorkspaceSummary = { id: "ws-1", name: "WS", plan: "starter", creditBalance: 10, role: "owner" };

const fake = vi.hoisted(() => ({
  workspace: null as unknown,
  workspaceError: null as unknown,
  download: null as unknown,
  files: null as unknown,
  register: null as unknown,
  calls: [] as unknown[][],
}));

vi.mock("@/lib/services", () => ({
  isDbMode: () => false,
  getServices: () => ({
    getCurrentWorkspace: async () => {
      if (fake.workspaceError) throw fake.workspaceError;
      return fake.workspace;
    },
    ensureWorkspace: async () => {
      if (fake.workspaceError) throw fake.workspaceError;
      return fake.workspace;
    },
    getJobFileDownload: async (...args: unknown[]) => {
      fake.calls.push(args);
      return fake.download;
    },
    listJobFiles: async (...args: unknown[]) => {
      fake.calls.push(args);
      return fake.files;
    },
    registerSourceMedia: async () => fake.register,
  }),
}));

vi.mock("@/lib/jobs/enqueue", () => ({ enqueueGeneratePack: vi.fn() }));

import { ProvisioningError } from "@/lib/services/db";
import { GET as downloadFile } from "./[id]/files/[fileId]/route";
import { GET as listFiles } from "./[id]/files/route";
import { GET as downloadPack } from "./[id]/pack/route";
import { POST as completeUpload } from "../uploads/complete/route";

function ctx<T>(params: T) {
  return { params: Promise.resolve(params) };
}

beforeEach(() => {
  fake.workspace = WORKSPACE;
  fake.workspaceError = null;
  fake.download = null;
  fake.files = null;
  fake.register = null;
  fake.calls = [];
});

describe("GET /api/jobs/:id/files/:fileId", () => {
  it("redirects to a freshly signed url for a file in the workspace", async () => {
    fake.download = { url: "https://r2.example/signed?x=1", filename: "MUG1.MAIN.jpg" } satisfies JobFileDownload;
    const response = await downloadFile(new Request("http://localhost"), ctx({ id: JOB_ID, fileId: "v_abc" }));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://r2.example/signed?x=1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fake.calls[0]).toEqual(["ws-1", JOB_ID, "v_abc"]);
  });

  it("answers 404 for an unknown file and for a job id that is not a uuid", async () => {
    expect((await downloadFile(new Request("http://localhost"), ctx({ id: JOB_ID, fileId: "v_x" }))).status).toBe(404);
    expect((await downloadFile(new Request("http://localhost"), ctx({ id: "abc", fileId: "v_x" }))).status).toBe(404);
    expect(fake.calls).toHaveLength(1);
  });

  it("answers 401 when signed out and 503 when the workspace could not be set up", async () => {
    fake.workspace = null;
    expect((await downloadFile(new Request("http://localhost"), ctx({ id: JOB_ID, fileId: "v_x" }))).status).toBe(401);
    fake.workspaceError = new ProvisioningError();
    const response = await downloadFile(new Request("http://localhost"), ctx({ id: JOB_ID, fileId: "v_x" }));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("Try again");
  });
});

describe("GET /api/jobs/:id/files", () => {
  it("answers 404 for a job id that is not a uuid without asking the service", async () => {
    const response = await listFiles(new Request("http://localhost"), ctx({ id: "abc" }));
    expect(response.status).toBe(404);
    expect(fake.calls).toHaveLength(0);
  });

  it("returns the file list", async () => {
    fake.files = { jobId: JOB_ID, status: "done", files: [] } satisfies JobFilesView;
    const response = await listFiles(new Request("http://localhost"), ctx({ id: JOB_ID }));
    expect(response.status).toBe(200);
    expect((await response.json()).jobId).toBe(JOB_ID);
  });
});

describe("GET /api/jobs/:id/pack", () => {
  it("answers 404 for a malformed id and outside db mode", async () => {
    expect((await downloadPack(new Request("http://localhost"), ctx({ id: "abc" }))).status).toBe(404);
    expect((await downloadPack(new Request("http://localhost"), ctx({ id: JOB_ID }))).status).toBe(404);
  });

  it("answers a browser navigation with a page and a way back instead of raw JSON", async () => {
    const response = await downloadPack(
      new Request("http://localhost", { headers: { accept: "text/html,application/xhtml+xml" } }),
      ctx({ id: JOB_ID }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Pack downloads are not available on this server.");
    expect(html).toContain(`href="/app/jobs/${JOB_ID}"`);
  });

  it("keeps JSON for API callers", async () => {
    const response = await downloadPack(new Request("http://localhost"), ctx({ id: JOB_ID }));
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});

describe("POST /api/uploads/complete status codes (Update.md 6.8)", () => {
  const body = JSON.stringify({
    productId: "00000000-0000-4000-8000-000000000101",
    key: "ws/ws-1/src/a",
    kind: "image",
    bytes: 10,
    sha256: "a".repeat(64),
  });

  async function statusFor(result: SaveResult): Promise<number> {
    fake.register = result;
    const response = await completeUpload(new Request("http://localhost", { method: "POST", body }));
    return response.status;
  }

  it("maps typed refusals to 403, 404 and 409", async () => {
    expect(await statusFor({ ok: false, reason: "forbidden", notice: "no" })).toBe(403);
    expect(await statusFor({ ok: false, reason: "foreign_key", notice: "no" })).toBe(403);
    expect(await statusFor({ ok: false, reason: "unknown_product", notice: "no" })).toBe(404);
    expect(await statusFor({ ok: false, reason: "conflict", notice: "no" })).toBe(409);
    expect(await statusFor({ ok: false, notice: "no" })).toBe(400);
    expect(await statusFor({ ok: true, notice: "saved" })).toBe(200);
  });
});

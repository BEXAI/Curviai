import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ gate: vi.fn(), review: vi.fn(), db: vi.fn(() => ({})), refresh: vi.fn() }));
vi.mock("@/lib/ops/access", () => ({ requireOperator: mocks.gate }));
vi.mock("@/lib/ops/gallery", () => ({ reviewGalleryItem: mocks.review }));
vi.mock("@/lib/services/db", () => ({ getDb: mocks.db }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.refresh }));
import { reviewGallery } from "./actions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.gate.mockResolvedValue({ user: { email: "founder@curvi.ai", email_confirmed_at: "2026-01-01" }, aal: "aal2" });
  mocks.review.mockResolvedValue(undefined);
});

function form() {
  const input = new FormData();
  input.set("itemId", "00000000-0000-4000-8000-000000000001");
  input.set("decision", "approved");
  input.set("operatorEmail", "forged@example.com");
  return input;
}

describe("gallery server actions", () => {
  it("checks the operator session before reading the database", async () => {
    mocks.gate.mockRejectedValue(new Error("Not found"));
    await expect(reviewGallery(form())).rejects.toThrow("Not found");
    expect(mocks.db).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it("uses the verified operator and assurance level, ignoring request identity", async () => {
    await reviewGallery(form());
    expect(mocks.review).toHaveBeenCalledWith({}, expect.objectContaining({ operator: { email: "founder@curvi.ai", email_confirmed_at: "2026-01-01" }, aal: "aal2" }));
    expect(mocks.refresh.mock.calls.map(([path]) => path)).toEqual(["/app/ops/gallery", "/gallery", "/sitemap.xml"]);
  });
});

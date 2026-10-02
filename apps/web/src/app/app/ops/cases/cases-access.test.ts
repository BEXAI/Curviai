import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const state = vi.hoisted(() => ({ access: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/ops/access", () => ({ requireOperator: state.access }));
vi.mock("@/lib/ops/cases", () => ({ operatorCases: state.list }));
vi.mock("@/lib/services", () => ({ isDbMode: () => true }));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({}) }));
vi.mock("./actions", () => ({ caseAction: async () => {} }));
import Page from "./[id]/page";
const id = "20000000-0000-4000-8000-000000000001";
beforeEach(() => {
  vi.resetAllMocks();
  state.access.mockResolvedValue({ user: { id, email: "operator@example.com" }, aal: "aal2" });
  state.list.mockResolvedValue([{ workspaceId: id, case: { id, jobId: id, category: "fidelity", status: "received", events: [{ id: "event", actor: "seller", status: "received", createdAt: "2026-10-01", message: "PUBLIC CASE TEXT" }] }, notes: [{ id: "note", createdAt: "2026-10-01", message: "PRIVATE OPERATOR TEXT <script>" }] }]);
});
describe("operator case access", () => {
  it("requires the operator and MFA guard before reading any private case data", async () => {
    state.access.mockRejectedValue(new Error("Operator MFA required"));
    await expect(Page({ params: Promise.resolve({ id }) })).rejects.toThrow("Operator MFA required");
    expect(state.list).not.toHaveBeenCalled();
  });
  it("masks the entire private timeline from analytics and escapes notes", async () => {
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ id }) }));
    expect(state.access).toHaveBeenCalledOnce();
    expect(html).toContain('class="ph-no-capture ph-mask max-w-3xl space-y-6"');
    expect(html).toContain("PRIVATE OPERATOR TEXT &lt;script&gt;"); expect(html).not.toContain("PRIVATE OPERATOR TEXT <script>");
    expect(html).toContain("Resolving a case does not grant credits");
  });
});

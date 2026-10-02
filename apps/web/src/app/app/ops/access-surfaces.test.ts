import { describe, expect, it, vi } from "vitest";

const denied = vi.hoisted(() => ({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" }));
vi.mock("@/lib/ops/access", () => ({ requireOperator: vi.fn(async () => { throw denied; }) }));
vi.mock("@/lib/services/db", () => ({ getDb: vi.fn(() => { throw new Error("Unauthorized database read"); }) }));
const { default: Overview } = await import("./page");
const { default: Jobs } = await import("./jobs/page");
const { default: Job } = await import("./jobs/[id]/page");
const { changeSwitch, grantWorkspaceCredits, providerAction } = await import("./actions");
const { jobAction } = await import("./jobs/actions");

describe("operator surfaces", () => {
  it("requires operator MFA before every overview/job page and mutation", async () => {
    for (const action of [() => Overview(), () => Jobs({ searchParams: Promise.resolve({}) }), () => Job({ params: Promise.resolve({ id: "invalid" }) }),
      () => changeSwitch(new FormData()), () => grantWorkspaceCredits(new FormData()), () => providerAction(new FormData()), () => jobAction(new FormData())]) {
      await expect(action()).rejects.toBe(denied);
    }
  });
});

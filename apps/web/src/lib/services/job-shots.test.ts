import { describe, expect, it } from "vitest";
import { buildShotViews, toShotStatus, type ShotStepRow } from "./job-shots";

const T0 = new Date("2026-09-28T10:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

function step(row: Partial<ShotStepRow> & Pick<ShotStepRow, "shotId" | "status">): ShotStepRow {
  return { stage: "lifestyle", provider: "worker", error: null, createdAt: T0, ...row };
}

describe("toShotStatus", () => {
  it("maps legacy failed rows to needs review and unknown ones to pending", () => {
    expect(toShotStatus("failed")).toBe("needs_review");
    expect(toShotStatus("needs_review")).toBe("needs_review");
    expect(toShotStatus("skipped")).toBe("skipped");
    expect(toShotStatus(null)).toBe("pending");
    expect(toShotStatus("mystery")).toBe("pending");
  });
});

describe("buildShotViews", () => {
  it("a finished row wins over a pending row written in the same instant", () => {
    const views = buildShotViews(
      [
        step({ shotId: "s01_main", status: "done", createdAt: T0 }),
        step({ shotId: "s01_main", status: "pending", provider: "pixel pipeline", createdAt: T0 }),
      ],
      [],
    );
    expect(views).toHaveLength(1);
    expect(views[0].status).toBe("done");
    expect(views[0].providerStage).toBe("pixel pipeline");
  });

  it("keys compliance by the asset's shot id, not its shot type (Update.md 3.6)", () => {
    const views = buildShotViews(
      [step({ shotId: "s01_lifestyle", status: "done" }), step({ shotId: "s02_lifestyle", status: "done" })],
      [
        { id: "a1", shotType: "lifestyle", qc: { shotId: "s02_lifestyle", pass: true, fillPct: 80, background: [255, 255, 255] } },
        { id: "a2", shotType: "lifestyle", qc: { shotId: "s01_lifestyle", pass: false } },
      ],
    );
    expect(views.find((v) => v.shotId === "s01_lifestyle")?.compliance?.pass).toBe(false);
    expect(views.find((v) => v.shotId === "s02_lifestyle")?.compliance).toEqual({
      pass: true,
      fillPct: 80,
      background: [255, 255, 255],
    });
  });

  it("orders planned shots by plan order and skipped shots last", () => {
    const views = buildShotViews(
      [
        step({ shotId: "s10_social_1x1", status: "pending", createdAt: T0 }),
        step({ shotId: "s02_alt_angle_white", status: "pending", createdAt: T0 }),
        step({ shotId: "skipped_01_in_the_box", status: "skipped", error: "seller did not list contents", createdAt: T0 }),
        step({ shotId: "s01_amazon_main", status: "pending", createdAt: T0 }),
        step({ shotId: "s10_social_1x1", status: "done", createdAt: later(1000) }),
      ],
      [],
    );
    expect(views.map((v) => v.shotId)).toEqual([
      "s01_amazon_main",
      "s02_alt_angle_white",
      "s10_social_1x1",
      "skipped_01_in_the_box",
    ]);
    expect(views[3].label).toBe("Needs details");
    expect(views[3].note).toContain("in the box");
  });

  it("explains a needs review shot in plain words from its repair hint", () => {
    const views = buildShotViews(
      [step({ shotId: "s01", status: "needs_review" })],
      [{ id: "a", shotType: "lifestyle", qc: { shotId: "s01", repairHint: "Fix failed checks: fill" } }],
    );
    expect(views[0].status).toBe("needs_review");
    expect(views[0].note).toBe("It did not pass this channel's checks after several tries. No credits were charged for it.");
  });

  it("reports credits and the channel only for delivered shots", () => {
    const views = buildShotViews(
      [step({ shotId: "s01", status: "done" }), step({ shotId: "s02", status: "needs_review" })],
      [
        { id: "a1", shotType: "lifestyle", qc: { shotId: "s01", credits: 1, specId: "amazon.secondary", pass: true } },
        { id: "a2", shotType: "lifestyle", qc: { shotId: "s02", credits: 1, specId: "amazon.secondary" } },
      ],
    );
    expect(views[0].credits).toBe(1);
    expect(views[0].channels).toEqual(["amazon.secondary"]);
    expect(views[1].credits).toBe(0);
  });

  it("hides generic worker labels", () => {
    const views = buildShotViews([step({ shotId: "s01", status: "done", provider: "worker" })], []);
    expect(views[0].providerStage).toBe("");
  });
});

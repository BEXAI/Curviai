import { describe, expect, it } from "vitest";
import {
  canReveal,
  makeoverDownloadPath,
  makeoverFilename,
  makeoverShareLink,
  pickSourcePhoto,
  revealShots,
  shotTitle,
} from "./makeover";
import type { JobShotView } from "./services/types";

function shot(partial: Partial<JobShotView> & Pick<JobShotView, "shotId" | "status">): JobShotView {
  return {
    shotType: "amazon_main",
    providerStage: "",
    channels: [],
    credits: 0,
    compliance: null,
    ...partial,
  };
}

describe("revealShots", () => {
  it("keeps only finished shots with a preview, in board order", () => {
    const shots = [
      shot({ shotId: "s01", status: "done", imageUrl: "https://r2/a.jpg", shotType: "amazon_main" }),
      shot({ shotId: "s02", status: "needs_review", imageUrl: "https://r2/b.jpg" }),
      shot({ shotId: "s03", status: "done", imageUrl: null }),
      shot({ shotId: "s04", status: "skipped" }),
      shot({ shotId: "s05", status: "done", imageUrl: "https://r2/c.jpg", shotType: "lifestyle_kitchen" }),
    ];
    expect(revealShots(shots)).toEqual([
      { shotId: "s01", shotType: "amazon_main", title: "Amazon main", imageUrl: "https://r2/a.jpg", channels: [] },
      { shotId: "s05", shotType: "lifestyle_kitchen", title: "Lifestyle kitchen", imageUrl: "https://r2/c.jpg", channels: [] },
    ]);
  });
});

describe("canReveal", () => {
  const done = [shot({ shotId: "s01", status: "done", imageUrl: "https://r2/a.jpg" })];

  it("needs a finished pack, the original photo and one finished shot", () => {
    expect(canReveal({ status: "done", sourceImageUrl: "https://r2/src.jpg", shots: done })).toBe(true);
    expect(canReveal({ status: "packaging", sourceImageUrl: "https://r2/src.jpg", shots: done })).toBe(false);
    expect(canReveal({ status: "done", sourceImageUrl: null, shots: done })).toBe(false);
    expect(canReveal({ status: "done", shots: done })).toBe(false);
    expect(canReveal({ status: "done", sourceImageUrl: "https://r2/src.jpg", shots: [] })).toBe(false);
  });
});

describe("makeoverShareLink", () => {
  const JOB = "00000000-0000-4000-8000-000000000abc";

  it("copies the workspace only pack page while public share pages are off", () => {
    expect(makeoverShareLink("https://curvi.ai/", JOB, false)).toEqual({
      url: `https://curvi.ai/app/jobs/${JOB}`,
      audience: "workspace",
    });
  });

  it("points at /s/[slug] once public share pages are live", () => {
    expect(makeoverShareLink("https://curvi.ai", JOB, true)).toEqual({ url: `https://curvi.ai/s/${JOB}`, audience: "public" });
  });

  it("defaults to the workspace link, since public pages live at a published slug, not the job id", () => {
    expect(makeoverShareLink("https://curvi.ai", JOB).audience).toBe("workspace");
  });
});

describe("makeover download", () => {
  it("encodes the shot id into the same origin route", () => {
    expect(makeoverDownloadPath("job-1", "s01 main&x")).toBe("/api/jobs/job-1/makeover?shot=s01%20main%26x");
  });

  it("names the file after the product and the shot", () => {
    expect(makeoverFilename("Juniper Glass Water Bottle!", "amazon_main")).toBe(
      "juniper-glass-water-bottle-before-after-amazon-main.jpg",
    );
    expect(makeoverFilename("", "lifestyle")).toBe("product-before-after-lifestyle.jpg");
  });

  it("titles shots like the shot cards", () => {
    expect(shotTitle("social_4x5")).toBe("Social 4x5");
  });
});

describe("pickSourcePhoto", () => {
  const started = new Date("2026-09-20T10:00:00Z");
  const row = (r2Key: string, iso: string, kind: string | null = "image") => ({ r2Key, kind, createdAt: new Date(iso) });
  const any = () => true;

  it("takes the newest still photo stored no later than the pack started", () => {
    const rows = [
      row("ws/w/src/old", "2026-09-19T10:00:00Z"),
      row("ws/w/src/same", "2026-09-20T10:00:00Z"),
      row("ws/w/src/video", "2026-09-20T09:59:59Z", "video"),
      row("ws/w/src/later", "2026-09-21T10:00:00Z"),
    ];
    expect(pickSourcePhoto(rows, started, any)?.r2Key).toBe("ws/w/src/same");
  });

  it("never shows a photo added after the pack as its before", () => {
    expect(pickSourcePhoto([row("ws/w/src/later", "2026-09-21T10:00:00Z")], started, any)).toBeNull();
  });

  it("skips keys the workspace check refuses", () => {
    const rows = [row("ws/other/src/theirs", "2026-09-20T09:00:00Z"), row("ws/w/src/mine", "2026-09-19T09:00:00Z")];
    expect(pickSourcePhoto(rows, started, (k) => k.startsWith("ws/w/"))?.r2Key).toBe("ws/w/src/mine");
  });

  it("treats a row without a kind as a still photo, as early rows had none", () => {
    expect(pickSourcePhoto([row("ws/w/src/a", "2026-09-19T00:00:00Z", null)], started, any)?.r2Key).toBe("ws/w/src/a");
  });
});

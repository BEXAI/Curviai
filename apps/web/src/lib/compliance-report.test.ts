import { describe, expect, it } from "vitest";
import { getSpec } from "@curvi/specs";
import {
  buildComplianceReportView,
  channelTitle,
  demoComplianceReport,
  describeCheck,
  NOT_MEASURED,
  specRequirementChecks,
  unavailableComplianceReport,
} from "./compliance-report";

const meta = { jobId: "00000000-0000-4000-8000-00000000a001", productTitle: "Copper kettle" };

// Shaped exactly like packages/pipeline buildPack's compliance-report.json.
const stored = {
  generatedAt: "2026-09-28T12:00:00.000Z",
  channels: ["amazon", "meta"],
  files: [
    {
      file: "SKU1.MAIN.jpg",
      channel: "amazon",
      specId: "amazon.main",
      ref: "s01",
      digitalSource: "none",
      badge: false,
      notes: [],
      checks: [
        { name: "dimensions", pass: true, measured: "2000x2000", limit: "1x1 to 2000x2000" },
        { name: "longestSide", pass: true, measured: 2000, limit: "1600 to 10000" },
        { name: "backgroundWhiteShare", pass: true, measured: 1, limit: ">= 1" },
        { name: "fillRatio", pass: false, measured: 0.8123, limit: "0.85 to 0.9" },
        { name: "bytes", pass: true, measured: 1_234_567, limit: "<= 10000000" },
        { name: "format", pass: true, measured: "jpg", limit: "jpg, png, tif, gif" },
      ],
      measured: null,
      pass: false,
    },
    {
      file: "meta_feed_1x1_01.png",
      channel: "meta",
      specId: "meta.feed_1x1",
      ref: "s02",
      digitalSource: "composite",
      badge: false,
      notes: ["iptc digital source type: composite", "badge suppressed: not allowed for this channel spec"],
      checks: [
        { name: "dimensions", pass: true, measured: "1080x1080", limit: "exactly 1080x1080" },
        { name: "longestSide", pass: true, measured: 1080, limit: `1080 to ${Number.MAX_SAFE_INTEGER}` },
      ],
      measured: null,
      pass: true,
    },
  ],
  dropped: [
    {
      file: "SKU1.PT09.jpg",
      channel: "amazon",
      specId: "amazon.secondary",
      ref: "s09",
      reason: "channel image limit: amazon.secondary takes at most 8 images",
    },
  ],
};

describe("buildComplianceReportView", () => {
  it("turns the stored report into plain spoken rows grouped by channel", () => {
    const view = buildComplianceReportView(stored, meta)!;
    expect(view.available).toBe(true);
    expect(view.demo).toBe(false);
    expect(view.summary).toEqual({ files: 2, passed: 1, needsAttention: 1, leftOut: 1 });
    expect(view.channels.map((c) => c.title)).toEqual(["Amazon", "Meta"]);

    const main = view.channels[0].files[0];
    expect(main.specLabel).toBe("Amazon main image");
    expect(main.pass).toBe(false);
    expect(main.checks.map((c) => [c.label, c.measured, c.required])).toEqual([
      ["Image size", "2000 x 2000 px", "at most 2000 x 2000 px"],
      ["Longest side", "2000 px", "1600 to 10000 px"],
      ["Pure white background", "100 percent", "100 percent"],
      ["Product fill", "81.23 percent", "85 percent to 90 percent"],
      ["File size", "1.2 MB", "at most 10 MB"],
      ["File format", "JPG", "JPG, PNG, TIF, GIF"],
    ]);

    const social = view.channels[1].files[0];
    expect(social.checks[0].required).toBe("exactly 1080 x 1080 px");
    expect(social.checks[1].required).toBe("at least 1080 px");
    expect(social.notes).toEqual([
      "Labeled in the file as a scene composited around your real product.",
      "The share badge was left off because this channel does not allow it.",
    ]);

    expect(view.dropped).toEqual([
      {
        file: "SKU1.PT09.jpg",
        channelTitle: "Amazon",
        reason: "Amazon secondary images takes at most 8 images, so this file was left out and not charged.",
      },
    ]);
  });

  it("returns null for anything that is not a report", () => {
    expect(buildComplianceReportView({ nope: true }, meta)).toBeNull();
    expect(buildComplianceReportView(null, meta)).toBeNull();
  });

  it("keeps every user facing string free of dashes, arrows and raw operators", () => {
    const view = buildComplianceReportView(stored, meta)!;
    const strings = [
      ...view.channels.flatMap((c) =>
        c.files.flatMap((f) => [...f.notes, ...f.checks.flatMap((k) => [k.label, k.measured, k.required])]),
      ),
      ...view.dropped.map((d) => d.reason),
    ];
    for (const text of strings) {
      expect(text).not.toMatch(/[‒-―←-⇿]|>=|<=|\s-\s/);
    }
  });
});

describe("describeCheck", () => {
  it("says a check that needed a mask could not be measured", () => {
    expect(describeCheck({ name: "fillRatio", pass: false, measured: "mask missing", limit: "0.85 to 0.9" }).measured).toBe(
      "Could not be measured",
    );
  });

  it("reads an any size limit as any size", () => {
    expect(
      describeCheck({
        name: "dimensions",
        pass: true,
        measured: "800x800",
        limit: `1x1 to ${Number.MAX_SAFE_INTEGER}x${Number.MAX_SAFE_INTEGER}`,
      }).required,
    ).toBe("any size");
  });
});

describe("demo and unavailable reports", () => {
  it("lists each demo file's requirements without inventing measurements", () => {
    const view = demoComplianceReport(meta, [
      { name: "demo.MAIN.jpg", specId: "amazon.main" },
      { name: "unknown.jpg", specId: "not.a.spec" },
    ]);
    expect(view.demo).toBe(true);
    expect(view.summary.files).toBe(1);
    const checks = view.channels[0].files[0].checks;
    expect(checks.every((c) => c.measured === NOT_MEASURED)).toBe(true);
    expect(checks.map((c) => c.label)).toContain("Pure white background");
    expect(checks.map((c) => c.label)).toContain("Product fill");
  });

  it("derives requirement rows from the spec registry", () => {
    const rows = specRequirementChecks(getSpec("meta.feed_1x1"));
    expect(rows[0]).toMatchObject({ label: "Image size", required: "exactly 1080 x 1080 px" });
  });

  it("builds an empty view with a notice", () => {
    const view = unavailableComplianceReport(meta, "Not yet.");
    expect(view).toMatchObject({ available: false, notice: "Not yet.", channels: [], dropped: [] });
  });

  it("names channels plainly", () => {
    expect(channelTitle("tiktokshop")).toBe("TikTok Shop");
    expect(channelTitle("newchannel")).toBe("Newchannel");
  });
});

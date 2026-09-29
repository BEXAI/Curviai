import { describe, expect, it } from "vitest";
import { TREATMENT_NOTES, treatmentNotes, type TreatmentNoteKey } from "@curvi/pipeline/treatment";
import { getSpec } from "@curvi/specs";
import {
  buildComplianceReportView,
  channelTitle,
  demoComplianceReport,
  describeCheck,
  describeNotes,
  MEGAPIXELS_CHECK,
  NOT_MEASURED,
  specRequirementChecks,
  unavailableComplianceReport,
  WHITE_OR_CLEAR_CHECK,
} from "./compliance-report";

// Rule 9: plain spoken, no emojis, no arrows, no dashes as punctuation.
const FORBIDDEN = /[–—→←]| - |->|=>|[\u{1F300}-\u{1FAFF}]/u;

/** One sample of every treatment note, built with the pipeline's own builders. */
const SAMPLE_NOTES: Record<TreatmentNoteKey, string> = {
  keptAtSellerRequest: TREATMENT_NOTES.keptAtSellerRequest,
  unchangedFile: TREATMENT_NOTES.unchangedFile,
  turnedUpright: TREATMENT_NOTES.turnedUpright,
  resizedFrom: TREATMENT_NOTES.resizedFrom(4032, 3024),
  padded: TREATMENT_NOTES.padded("#f4f4f5"),
  cropped: TREATMENT_NOTES.cropped,
  cropFallback: TREATMENT_NOTES.cropFallback,
  enlarged: TREATMENT_NOTES.enlarged(1.3),
  colorConverted: TREATMENT_NOTES.colorConverted,
  alphaFilled: TREATMENT_NOTES.alphaFilled("#F4F4F5"),
  otherItems: TREATMENT_NOTES.otherItems,
  alreadyWhite: TREATMENT_NOTES.alreadyWhite,
  whiteRequired: TREATMENT_NOTES.whiteRequired,
  color: TREATMENT_NOTES.color("#1f2a44"),
};

describe("treatment notes", () => {
  it("maps every note to exactly one sentence from the plan", () => {
    const expected: Record<TreatmentNoteKey, string> = {
      keptAtSellerRequest: "Your photo, kept as you took it. Nothing in it was redrawn.",
      unchangedFile: "Your photo file as uploaded, with location and camera details removed.",
      turnedUpright: "Your photo was turned upright when you uploaded it.",
      resizedFrom: "Resized from 4032 by 3024 pixels.",
      padded: "Space added around your photo in #F4F4F5 to fit this channel's shape.",
      cropped: "Trimmed to this channel's shape. Your whole product stays in the picture.",
      cropFallback:
        "We never trim your product. It could not be trimmed to this channel's shape without cutting into it, so it was fitted without trimming.",
      enlarged: "Enlarged 1.3 times to reach this channel's minimum size.",
      colorConverted: "Colors converted to the standard sRGB profile that marketplaces expect.",
      alphaFilled: "Transparent areas of your photo were filled with #F4F4F5.",
      otherItems: "Other items in this photo stay in the picture because you kept the background.",
      alreadyWhite: "Your photo already had a pure white background, so we only resized it.",
      whiteRequired: "This channel needs pure white, so this file uses white instead of your color.",
      color: "Background color you chose, #1F2A44.",
    };
    expect(Object.keys(SAMPLE_NOTES).sort()).toEqual(Object.keys(TREATMENT_NOTES).sort());
    for (const [key, note] of Object.entries(SAMPLE_NOTES)) {
      const sentences = describeNotes([note], "none");
      expect(sentences, key).toEqual([expected[key as TreatmentNoteKey]]);
      expect(sentences[0]).not.toMatch(FORBIDDEN);
    }
  });

  it("says a white required file on a Keep pack had its background removed for that file only", () => {
    expect(describeNotes([TREATMENT_NOTES.whiteRequired], "none", { keptBackground: true })).toEqual([
      "This channel needs a pure white background, so the background was removed for this file only.",
    ]);
  });

  it("gives an unchanged file one sentence that says whether it was turned upright", () => {
    const upright = treatmentNotes({ kind: "original_unchanged", reencodedAtUpload: true });
    expect(describeNotes(upright, "none")).toEqual([
      "Your photo, kept as you took it. Nothing in it was redrawn.",
      "Your photo file, turned upright when you uploaded it, with location and camera details removed.",
    ]);
    const asUploaded = treatmentNotes({ kind: "original_unchanged", reencodedAtUpload: false });
    expect(describeNotes(asUploaded, "none")).toEqual([
      "Your photo, kept as you took it. Nothing in it was redrawn.",
      "Your photo file as uploaded, with location and camera details removed.",
    ]);
    // An older upload with no ingest record carries a stored copy note of its own.
    const stored = TREATMENT_NOTES.turnedUpright.split(",")[0] + ", no ingest record";
    expect(describeNotes([TREATMENT_NOTES.unchangedFile, stored], "none")).toEqual([
      "Your photo file as stored when you uploaded it, with location and camera details removed.",
    ]);
  });

  it("describes a whole rendered kept photo in order", () => {
    const notes = treatmentNotes({
      kind: "original",
      scale: 0.5,
      sourceWidth: 4032,
      sourceHeight: 3024,
      colorConverted: true,
      padHex: "#FFFFFF",
      otherItems: true,
    });
    const sentences = describeNotes(notes, "none");
    expect(sentences).toHaveLength(notes.length);
    expect(sentences[0]).toContain("Nothing in it was redrawn");
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(FORBIDDEN);
      expect(sentence).not.toMatch(/identical|100 percent/i);
    }
  });
});

describe("PHASE_15 check labels", () => {
  it("labels the white or clear check from the spec's rule", () => {
    const check = { name: WHITE_OR_CLEAR_CHECK, pass: true, measured: 0.9995, limit: ">= 0.999" };
    expect(describeCheck(check, "google.merchant.main")).toMatchObject({
      label: "White or transparent background",
      required: "at least 99.9 percent",
    });
    expect(describeCheck(check, "tiktokshop.main").label).toBe("White background");
    expect(describeCheck(check).label).toBe("White or transparent background");
  });

  it("labels the megapixels check in megapixels", () => {
    const row = describeCheck({ name: MEGAPIXELS_CHECK, pass: false, measured: 80_000_000, limit: "<= 64" });
    expect(row).toMatchObject({ label: "Megapixels", measured: "80 megapixels", required: "at most 64 megapixels" });
    expect(describeCheck({ name: MEGAPIXELS_CHECK, pass: true, measured: 12.19, limit: "<= 64000000" })).toMatchObject({
      measured: "12.2 megapixels",
      required: "at most 64 megapixels",
    });
    expect(specRequirementChecks(getSpec("google.merchant.lifestyle")).map((c) => c.label)).toContain("Megapixels");
    for (const text of [row.label, row.measured, row.required]) {
      expect(text).not.toMatch(FORBIDDEN);
    }
  });
});

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

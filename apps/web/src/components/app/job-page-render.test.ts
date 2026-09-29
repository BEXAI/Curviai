import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canvasSizeFor,
  normalizeOutputOptions,
  resolveOutputOptions,
  specAcceptsImage,
  type OutputOptionsInput,
} from "@curvi/pipeline/output-options";
import { stillStyle } from "@curvi/pipeline/seed";
import { getSpec, listSpecs } from "@curvi/specs";
import { JobOptionsCard, lookTitle } from "@/components/app/job-options-card";
import { ShotCard } from "@/components/app/job-progress-board";
import { downloadAllState, FilePreview } from "@/components/app/pack-downloads";
import { PackReveal } from "@/components/app/pack-reveal";
import { demoComplianceReport, specRequirementChecks } from "@/lib/compliance-report";
import { outputOptionsSummary, skippedCopy } from "@/lib/job-copy";
import { revealShots } from "@/lib/makeover";
import { SIZED_FOR_EACH_CHANNEL_TITLE } from "@/lib/output-options-copy";
import { boardShots, isTurnedOffShot, previewAspect, SQUARE_ASPECT } from "@/lib/output-preview";
import { SELLER_OFF_REASON } from "@curvi/pipeline/output-options";
import type { JobShotView } from "@/lib/services/types";

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

function resolved(input: OutputOptionsInput, keepMediaIds: string[] = []) {
  return resolveOutputOptions(normalizeOutputOptions(input), {
    colorHex: stillStyle.whiteHex,
    brandSweepHex: stillStyle.whiteHex,
    keepMediaIds,
  });
}

function shot(partial: Partial<JobShotView> & Pick<JobShotView, "shotId" | "shotType">): JobShotView {
  return {
    providerStage: "",
    status: "done",
    channels: [],
    credits: 0,
    compliance: null,
    ...partial,
  };
}

const JOB = { id: "00000000-0000-4000-8000-000000000abc", status: "done" as const };
const noop = () => undefined;

function renderShot(view: JobShotView): string {
  return renderToStaticMarkup(React.createElement(ShotCard, { shot: view, job: JOB, canManage: true, onAction: noop }));
}

/** CLAUDE.md rule 9: no emoji, no arrows, no en or em dashes, no " - ". */
function expectPlainCopy(text: string) {
  expect(text).not.toMatch(/[‒-―←-⇿⟰-⟿]|\p{Extended_Pictographic}/u);
  expect(text).not.toContain(" - ");
}

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

describe("Your choices card", () => {
  it("shows the look and each line from JobView.outputOptions", () => {
    const summary = outputOptionsSummary(resolved({ lookBase: "keep_photo", background: "keep" }, ["a", "b", "c"]), {
      specIds: ["amazon.main", "amazon.secondary", "etsy.listing"],
      photoCount: 3,
    });
    const html = renderToStaticMarkup(React.createElement(JobOptionsCard, { options: summary }));
    expect(html).toContain('data-testid="job-options-card"');
    expect(html).toContain("Your choices");
    expect(html).toContain(lookTitle(summary.look));
    expect(html).toContain("Background kept as you took it, on 3 photos.");
    expect(html).toContain("background removed, because Amazon requires white.");
    expect(html.match(/data-testid="job-options-line"/g)).toHaveLength(summary.lines.length);
    expectPlainCopy(visibleText(html));
  });

  it("renders nothing when the stored options could not be read", () => {
    expect(renderToStaticMarkup(React.createElement(JobOptionsCard, { options: undefined }))).toBe("");
  });

  it("names a changed preset Custom", () => {
    expect(lookTitle("custom")).toBe("Custom");
  });
});

describe("shot card previews", () => {
  it("shows the whole file inside a box in the channel's shape, never a cropped square", () => {
    const html = renderShot(shot({ shotId: "s01", shotType: "social_4x5", channels: ["meta.feed_4x5"], imageUrl: "https://r2/a.jpg" }));
    const { width, height } = canvasSizeFor(getSpec("meta.feed_4x5"));
    expect(html).toContain(`aspect-ratio:${width} / ${height}`);
    expect(html).toContain("object-contain");
    expect(html).not.toContain("object-cover");
    expect(html).not.toContain("aspect-square");
    expect(html).not.toContain('data-transparent="true"');
  });

  it("draws the checkerboard behind a transparent PNG", () => {
    const html = renderShot(shot({ shotId: "s02", shotType: "cutout_png", channels: ["shopify.product"], imageUrl: "https://r2/a.png" }));
    expect(html).toContain('data-transparent="true"');
    expect(html).toContain("repeating-conic-gradient");
  });

  it("uses a square box for a shot with no known channel", () => {
    expect(previewAspect([])).toEqual(SQUARE_ASPECT);
    expect(previewAspect([null, "no.such.spec"])).toEqual(SQUARE_ASPECT);
  });

  it("shows no background reading on a kept photo", () => {
    const html = renderShot(
      shot({
        shotId: "s03",
        shotType: "original_photo",
        channels: ["etsy.listing"],
        imageUrl: "https://r2/a.jpg",
        compliance: { pass: true, fillPct: null, background: [244, 244, 245] },
      }),
    );
    expect(html).toContain("Passes channel rules");
    expect(html).not.toContain("background 244");
  });

  it("hides shots the seller turned off and keeps every other skipped shot", () => {
    const off = skippedCopy(SELLER_OFF_REASON, "lifestyle");
    const needsPhoto = skippedCopy("needs photo", "alt_angle_white");
    const shots = [
      shot({ shotId: "s01", shotType: "amazon_main" }),
      shot({ shotId: "s02", shotType: "lifestyle", status: "skipped", label: off.label, note: off.note }),
      shot({ shotId: "s03", shotType: "alt_angle_white:back", status: "skipped", label: needsPhoto.label }),
    ];
    expect(isTurnedOffShot(shots[1])).toBe(true);
    expect(boardShots(shots).map((s) => s.shotId)).toEqual(["s01", "s03"]);
  });
});

describe("reveal", () => {
  const source = "https://r2/source.jpg";

  it("titles a pack of only kept photos Sized for each channel, with no before and after", () => {
    const shots = revealShots([
      shot({ shotId: "s01", shotType: "original_photo", channels: ["etsy.listing"], imageUrl: "https://r2/a.jpg" }),
      shot({ shotId: "s02", shotType: "original_photo:2", channels: ["meta.feed_4x5"], imageUrl: "https://r2/b.jpg" }),
    ]);
    const html = renderToStaticMarkup(React.createElement(PackReveal, { jobId: JOB.id, sourceImageUrl: source, shots }));
    expect(html).toContain(SIZED_FOR_EACH_CHANNEL_TITLE);
    expect(html).toContain('data-reveal-kind="sized"');
    expect(html).not.toContain("Before and after");
    expect(html).not.toContain("reveal-slider");
    expect(html).not.toContain("download-makeover");
    expect(html).not.toContain(source);
    const { width, height } = canvasSizeFor(getSpec("meta.feed_4x5"));
    expect(html).toContain(`aspect-ratio:${width} / ${height}`);
    expectPlainCopy(visibleText(html));
  });

  it("keeps the before and after when any hero candidate is made by Curvi", () => {
    const shots = revealShots([
      shot({ shotId: "s01", shotType: "amazon_main", channels: ["amazon.main"], imageUrl: "https://r2/a.jpg" }),
      shot({ shotId: "s02", shotType: "original_photo", channels: ["etsy.listing"], imageUrl: "https://r2/b.jpg" }),
    ]);
    const html = renderToStaticMarkup(React.createElement(PackReveal, { jobId: JOB.id, sourceImageUrl: source, shots }));
    expect(html).toContain("Before and after");
    expect(html).toContain('data-reveal-kind="before_after"');
    expect(html).toContain("download-makeover");
    expect(html).not.toContain(SIZED_FOR_EACH_CHANNEL_TITLE);
  });

  it("never says public share pages are coming soon, and points at the Share this makeover panel", () => {
    for (const shotType of ["amazon_main", "original_photo"]) {
      const shots = revealShots([
        shot({ shotId: "s01", shotType, channels: ["amazon.main"], imageUrl: "https://r2/a.jpg" }),
      ]);
      const html = renderToStaticMarkup(React.createElement(PackReveal, { jobId: JOB.id, sourceImageUrl: source, shots }));
      const text = visibleText(html);
      expect(text, shotType).not.toMatch(/coming soon/i);
      expect(text, shotType).toContain("publish a share page in Share this makeover below");
      expectPlainCopy(text);
    }
  });
});

describe("Download all files", () => {
  const image = { kind: "image" as const, downloadUrl: "/api/jobs/x/files/1" };

  it("offers the zip only once the pack is done, since the pack route zips only done packs", () => {
    expect(downloadAllState({ files: [image] as never }, true)).toBe("link");
    expect(downloadAllState({ files: [image] as never }, false)).toBe("after_rerun");
    expect(downloadAllState({ files: [] }, true)).toBe("none");
    expect(downloadAllState({ files: [{ kind: "image", downloadUrl: null }] as never }, true)).toBe("none");
  });
});

describe("download previews", () => {
  it("use the channel's box, with the checkerboard behind a PNG only", () => {
    const png = renderToStaticMarkup(
      React.createElement(FilePreview, { file: { name: "sku_shopify_1.png", specId: "meta.story_9x16", url: "https://r2/a.png" } }),
    );
    const { width, height } = canvasSizeFor(getSpec("meta.story_9x16"));
    expect(png).toContain(`aspect-ratio:${width} / ${height}`);
    expect(png).toContain('data-transparent="true"');
    const jpg = renderToStaticMarkup(
      React.createElement(FilePreview, { file: { name: "sku_etsy_1.jpg", specId: "etsy.listing", url: "https://r2/a.jpg" } }),
    );
    expect(jpg).not.toContain('data-transparent="true"');
    const missing = renderToStaticMarkup(
      React.createElement(FilePreview, { file: { name: "sku_etsy_1.jpg", specId: "etsy.listing", url: null } }),
    );
    expect(missing).toContain("Preview unavailable");
  });
});

describe("the pure white background check on original files", () => {
  it("is never among the checks of a spec a kept photo can ship on", () => {
    const specs = listSpecs().filter((spec) => specAcceptsImage(spec, "original"));
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(specRequirementChecks(spec).map((check) => check.label)).not.toContain("Pure white background");
    }
  });

  it("never shows in a report of kept photo files", () => {
    const report = demoComplianceReport({ jobId: JOB.id, productTitle: "Bottle" }, [
      { name: "a.jpg", specId: "etsy.listing", treatment: { kind: "original" } },
      { name: "b.jpg", specId: "amazon.secondary", treatment: { kind: "original_unchanged" } },
    ]);
    const labels = report.channels.flatMap((c) => c.files.flatMap((f) => f.checks.map((check) => check.label)));
    expect(labels.length).toBeGreaterThan(0);
    expect(labels).not.toContain("Pure white background");
  });
});

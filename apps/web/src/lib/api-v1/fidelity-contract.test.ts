import { describe, expect, it } from "vitest";
import type { StoredFidelity } from "@curvi/pipeline/fidelity-record";
import { complianceFromQc } from "@/lib/services/job-shots";
import type { JobFileView, JobShotView, JobView } from "@/lib/services/types";
import { packOf } from "./actions";
import { PackChatImage, packImagesOf } from "./chat-views";
import { componentSchema } from "./openapi";
import { PackResponse } from "./schemas";

// P18-08: the API's ShotCompliance gains a nullable fidelity object, the
// OpenAPI document follows, and the numbers are the ones the asset stores.

const fidelity: StoredFidelity = {
  meanDeltaE: 0.84,
  maxDeltaE: 3.2,
  exactByteShare: 0.4123,
  maskArea: 52000,
  threshold: 3,
  maxDeltaELimit: 10,
  kind: "main",
  exact: false,
};

function shot(compliance: JobShotView["compliance"]): JobShotView {
  return {
    shotId: "s01_amazon_main",
    shotType: "amazon_main",
    providerStage: "pixel pipeline",
    status: "done",
    channels: ["amazon.main"],
    credits: 1,
    compliance,
  };
}

function job(shots: JobShotView[]): JobView {
  return {
    id: "00000000-0000-4000-8000-0000000018a8",
    productId: "00000000-0000-4000-8000-0000000018a9",
    productTitle: "Amber candle",
    status: "done",
    mode: "listing",
    channels: ["amazon"],
    creditsReserved: 8,
    creditsCharged: 8,
    createdAt: "2026-10-01T12:00:00.000Z",
    shots,
  };
}

describe("ShotCompliance.fidelity in API v1", () => {
  it("serves the asset's stored numbers and matches the documented schema", () => {
    const compliance = complianceFromQc({ pass: true, fillPct: 87, background: [255, 255, 255], fidelity });
    expect(compliance?.fidelity).toEqual(fidelity);
    const pack = packOf(job([shot(compliance)]));
    expect(pack.shots[0].compliance?.fidelity).toEqual(fidelity);
    expect(PackResponse.safeParse({ pack }).success).toBe(true);
  });

  it("answers null for a shot with no numbers and for rows made before Phase 18", () => {
    const older = complianceFromQc({ pass: true, fillPct: 87, background: null });
    expect(older?.fidelity ?? null).toBeNull();
    const pack = packOf(job([shot(older), shot({ pass: true, fillPct: null, background: null })]));
    expect(pack.shots.map((s) => s.compliance?.fidelity)).toEqual([null, null]);
    expect(PackResponse.safeParse({ pack }).success).toBe(true);
  });

  it("refuses a body whose compliance leaves the field out", () => {
    const pack = packOf(job([shot({ pass: true, fillPct: 87, background: null })]));
    const { fidelity: _dropped, ...without } = pack.shots[0].compliance!;
    expect(PackResponse.safeParse({ pack: { ...pack, shots: [{ ...pack.shots[0], compliance: without }] } }).success).toBe(false);
  });

  it("documents the field in the OpenAPI component", () => {
    const text = JSON.stringify(componentSchema("PackResponse"));
    for (const field of ["fidelity", "meanDeltaE", "maxDeltaE", "exactByteShare", "maxDeltaELimit"]) {
      expect(text).toContain(`"${field}"`);
    }
  });
});

describe("delivered file fidelity in MCP results", () => {
  it("returns each file's stored measurements without substituting the shot's numbers", () => {
    const pack = packOf(job([shot(complianceFromQc({ pass: true, fidelity }))]));
    const delivered = { ...fidelity, meanDeltaE: 1.21, exactByteShare: 0.28 };
    const file: JobFileView = {
      id: "v_first", name: "candle.jpg", channel: "amazon", specId: "amazon.main", kind: "image",
      bytes: 1, url: null, downloadUrl: "/file", shotId: "s01_amazon_main", fidelity: delivered,
    };
    const images = packImagesOf([
      file,
      { ...file, id: "v_unmeasured", fidelity: undefined },
      { ...file, id: "p_zip", kind: "zip" },
    ], pack.shots, new Map());
    expect(PackChatImage.parse(images[0]).fidelity).toEqual(delivered);
    expect(images[0]?.fidelity).not.toEqual(fidelity);
    expect(images[1]?.fidelity).toBeNull();
    expect(images[2]?.fidelity).toBeNull();
  });
});

/**
 * Shared rule 3 assertions for the live runner tests (CLAUDE.md rule 3):
 * product pixels inside the mask are never regenerated. Test only.
 */
import { expect } from "vitest";
import { decodeToRgba, fidelityReport, qcKindForSpec } from "@curvi/pipeline";
import { tintInsideMask } from "@curvi/pipeline/testing";
import { getSpec } from "@curvi/specs";
import type { ShotGeneration } from "../pipeline-runner";

/**
 * The rule 3 invariant for one shipped file: decoded bytes equal the image
 * the runner checks, the product reference matches inside the eroded mask
 * (byte for byte when the file is lossless), and a tint inside the product
 * fails the same check.
 */
export async function expectProductKept(generation: ShotGeneration, specId: string): Promise<void> {
  const spec = getSpec(specId);
  if (spec.width) expect(generation.image.width).toBe(spec.width);
  if (spec.height) expect(generation.image.height).toBe(spec.height);
  const shipped = await decodeToRgba(generation.encoded.buffer);
  expect(shipped.data.equals(generation.image.data)).toBe(true);
  if (!generation.mask || !generation.productReference) {
    throw new Error("a live output must carry its mask and product reference");
  }
  const opts = { kind: qcKindForSpec(spec), erodePx: generation.fidelityErodePx };
  const report = await fidelityReport(generation.productReference, shipped, generation.mask, opts);
  expect(report.issues, specId).toEqual([]);
  expect(report.maskArea).toBeGreaterThan(0);
  if (generation.encoded.format === "png") {
    expect(report.exactByteShare, specId).toBe(1);
  }
  const tinted = await fidelityReport(
    generation.productReference,
    tintInsideMask(shipped, generation.mask, 30),
    generation.mask,
    opts,
  );
  expect(tinted.pass).toBe(false);
}

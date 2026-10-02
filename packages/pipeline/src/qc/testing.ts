/**
 * TESTING ONLY mock engines for the pluggable semantic checks. These report
 * perfect scores unconditionally, so they must never be wired as defaults or
 * reached implicitly from production code paths: semanticChecks requires its
 * engines explicitly, and only tests and the eval harness import this module.
 */
import type { RawImage, RawMask } from "../raw";
import type { EmbeddingCosineCheck, OcrTextCheck } from "./pixelChecks";

/** Mock OCR: sees no stray text and reports a perfect label match. */
export class MockOcrTextCheck implements OcrTextCheck {
  readonly name = "mock-ocr";
  async nonProductText(_image: RawImage, _mask: RawMask): Promise<string> {
    return "";
  }
  async labelMatch(_original: RawImage, _composed: RawImage, _mask: RawMask): Promise<number> {
    return 1;
  }
}

/** Mock embedding check: reports perfect similarity. */
export class MockEmbeddingCosineCheck implements EmbeddingCosineCheck {
  readonly name = "mock-embedding";
  async cosine(_original: RawImage, _composed: RawImage, _mask: RawMask): Promise<number> {
    return 1;
  }
}

/** Copy of image with red raised by amount inside mask, like a stray tint:
 * the rule 3 tests check that a fidelity report fails on it. */
export function tintInsideMask(image: RawImage, mask: RawMask, amount: number): RawImage {
  const data = Buffer.from(image.data);
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i] === 0) continue;
    data[i * 4] = Math.min(255, data[i * 4] + amount);
  }
  return { ...image, data };
}

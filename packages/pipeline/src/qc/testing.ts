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

/**
 * applyBadge re-encodes a file that already passed QC, so the badged bytes
 * are checked again before they may ship: product fidelity against the
 * unbadged file (CLAUDE.md rule 3) and the channel byte cap. Both failures
 * are forced here through mocks, since no real encoder setting or seeded
 * badge spec trips them today.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawImage } from "../raw";

const knobs = vi.hoisted(() => ({ jpegQuality: null as number | null, maxBytes: null as number | null }));

vi.mock("../raw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../raw")>();
  return {
    ...actual,
    encodeJpeg: (img: RawImage, quality?: number) => actual.encodeJpeg(img, knobs.jpegQuality ?? quality),
  };
});

vi.mock("@curvi/specs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@curvi/specs")>();
  return {
    ...actual,
    getSpec: (id: string) => {
      const spec = actual.getSpec(id);
      return knobs.maxBytes === null ? spec : { ...spec, maxBytes: knobs.maxBytes };
    },
  };
});

const { applyBadge } = await import("./badge");
const { buildPack } = await import("./index");
const { encodeJpeg, encodePng } = await import("../raw");
const { rawCanvas, rectMask } = await import("../testutil");

const SIZE = 400;
const productBox = { left: 120, top: 120, width: 160, height: 160 };

/** A product with fine texture, which a very low quality JPEG smears. */
function texturedCanvas(): RawImage {
  const raw = rawCanvas(SIZE, SIZE, 236, 230, 220);
  let seed = 7;
  for (let y = productBox.top; y < productBox.top + productBox.height; y++) {
    for (let x = productBox.left; x < productBox.left + productBox.width; x++) {
      const o = (y * SIZE + x) * 4;
      for (let c = 0; c < 3; c++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        raw.data[o + c] = seed % 256;
      }
    }
  }
  return raw;
}

const mask = rectMask(SIZE, SIZE, productBox);

afterEach(() => {
  knobs.jpegQuality = null;
  knobs.maxBytes = null;
});

describe("applyBadge rechecks the badged bytes", () => {
  it("applies the badge when the re-encoded file still passes", async () => {
    const buffer = await encodeJpeg(texturedCanvas());
    const outcome = await applyBadge(buffer, "jpg", "meta.feed_1x1", mask);
    expect(outcome.applied).toBe(true);
  });

  it("leaves the badge off when the re-encode moves the product pixels", async () => {
    const buffer = await encodeJpeg(texturedCanvas());
    knobs.jpegQuality = 1;
    const outcome = await applyBadge(buffer, "jpg", "meta.feed_1x1", mask);
    expect(outcome).toMatchObject({ applied: false, reason: expect.stringContaining("product pixels") });
  });

  it("leaves the badge off when the badged file is over the channel byte cap", async () => {
    const buffer = await encodePng(texturedCanvas());
    knobs.maxBytes = buffer.length - 1;
    const outcome = await applyBadge(buffer, "png", "meta.feed_1x1", mask);
    expect(outcome).toMatchObject({ applied: false, reason: expect.stringContaining("size limit") });
  });

  it("ships the unbadged bytes from buildPack when the recheck fails", async () => {
    const buffer = await encodeJpeg(texturedCanvas());
    knobs.jpegQuality = 1;
    const result = await buildPack(
      [{ specId: "meta.feed_1x1", buffer, format: "jpg", mask, badge: true }],
      ["meta"],
      { writeFiles: true },
    );
    const entry = result.report.files[0];
    expect(entry.badge).toBe(false);
    expect(entry.notes.join(" ")).toMatch(/badge left off: the badged file did not keep the product pixels intact/);
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const shipped = await readFile(path.join(result.outDir, "files", "meta", entry.file));
    expect(shipped.equals(buffer)).toBe(true);
  });
});

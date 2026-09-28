import { describe, expect, it } from "vitest";
import { intentFor, intentFingerprint, type SubmitIntentFields } from "./submit-intent";

const BASE: SubmitIntentFields = {
  productId: "new",
  channels: ["amazon.main", "shopify.product"],
  mode: "listing",
  uploadKey: "ws/w/src/1",
  newProductTitle: "Mug",
  description: "",
};

function counter() {
  let n = 0;
  return () => `key-${++n}`;
}

describe("intentFor (Update.md 6.1)", () => {
  it("reuses the key when the same form is submitted again", () => {
    const next = counter();
    const first = intentFor(null, BASE, next);
    const retry = intentFor(first, { ...BASE }, next);
    expect(retry.key).toBe(first.key);
    expect(retry).toBe(first);
  });

  it("ignores channel order and surrounding whitespace", () => {
    const next = counter();
    const first = intentFor(null, BASE, next);
    const reordered = intentFor(
      first,
      { ...BASE, channels: ["shopify.product", "amazon.main"], newProductTitle: " Mug ", description: "  " },
      next,
    );
    expect(reordered.key).toBe(first.key);
  });

  it("issues a new key when anything that is sent changes", () => {
    const changes: Array<Partial<SubmitIntentFields>> = [
      { productId: "00000000-0000-4000-8000-000000000101" },
      { channels: ["amazon.main"] },
      { mode: "concept" },
      { uploadKey: "ws/w/src/2" },
      { uploadKey: null },
      { newProductTitle: "Kettle" },
      { description: "Glass" },
    ];
    for (const change of changes) {
      const next = counter();
      const first = intentFor(null, BASE, next);
      expect(intentFor(first, { ...BASE, ...change }, next).key).not.toBe(first.key);
    }
  });

  it("a cleared intent gets a new key, as after a successful submit", () => {
    const next = counter();
    const first = intentFor(null, BASE, next);
    expect(intentFor(null, BASE, next).key).not.toBe(first.key);
  });

  it("the product name only matters for a new product", () => {
    const existing = { ...BASE, productId: "00000000-0000-4000-8000-000000000101" };
    expect(intentFingerprint({ ...existing, newProductTitle: "A" })).toBe(
      intentFingerprint({ ...existing, newProductTitle: "B" }),
    );
  });
});

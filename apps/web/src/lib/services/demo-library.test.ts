import { describe, expect, it } from "vitest";
import { estimatePackCredits } from "@/lib/pack-estimate";
import { DEMO_TIER, DemoService, DemoStore } from "./demo";

// Demo mode keeps the seller inputs a pack saves and lists every product
// with its packs, so the products library and the new pack form work with
// no database.

const FIXED_NOW = () => new Date("2026-09-28T12:00:00.000Z");
const CHANNELS = ["amazon.main", "shopify.product"];

function service(): DemoService {
  return new DemoService(new DemoStore(), FIXED_NOW);
}

describe("demo seller inputs and library", () => {
  it("saves the details on the new product and holds credits for the images they add", async () => {
    const svc = service();
    const workspace = await svc.getCurrentWorkspace();
    const result = await svc.createJob(workspace.id, {
      productId: "new",
      newProductTitle: "Pour over mug",
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: "demo-seller-1",
      uploads: [
        { key: "ws/demo/src/front", sha256: "a".repeat(64), kind: "image", angle: "front" },
        { key: "ws/demo/src/box", sha256: "b".repeat(64), kind: "image", angle: "in_the_box" },
      ],
      sku: "MUG-12",
      boxContents: ["Mug", "Pour over cone"],
      comparisonFacts: ["Holds 12 oz, most hold 8 oz"],
    });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    expect(result.job.shots.map((s) => s.shotType)).toEqual(expect.arrayContaining(["in_the_box", "comparison"]));
    expect(result.job.creditsReserved).toBe(
      estimatePackCredits(CHANNELS, "listing", DEMO_TIER, {
        angles: ["front", "in_the_box"],
        hasBoxContents: true,
        hasComparisonFacts: true,
      }).total,
    );

    const library = await svc.listProductLibrary(workspace.id);
    const mug = library.find((p) => p.title === "Pour over mug");
    expect(mug).toMatchObject({
      sku: "MUG-12",
      boxContents: ["Mug", "Pour over cone"],
      comparisonFacts: ["Holds 12 oz, most hold 8 oz"],
      photoCount: 2,
    });
    expect(mug?.packs.map((p) => [p.id, p.channels, p.creditsReserved])).toEqual([
      [result.job.id, CHANNELS, result.job.creditsReserved],
    ]);
    // The new product leads the library; fixtures follow with no packs.
    expect(library[0].title).toBe("Pour over mug");
    expect(library.slice(1).every((p) => p.packs.length === 0)).toBe(true);
  });

  it("keeps saved details a later pack leaves out and lists packs newest first", async () => {
    const svc = service();
    const workspace = await svc.getCurrentWorkspace();
    const [bottle] = await svc.listProducts(workspace.id);
    const first = await svc.createJob(workspace.id, {
      productId: bottle.id,
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: "demo-seller-2",
      sku: "",
    });
    const second = await svc.createJob(workspace.id, {
      productId: bottle.id,
      channels: ["amazon.main"],
      mode: "listing",
      idempotencyKey: "demo-seller-3",
    });
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("created");
    const saved = await svc.getProduct(workspace.id, bottle.id);
    expect(saved?.sku).toBeNull();
    expect(saved?.boxContents).toEqual(bottle.boxContents);
    const entry = (await svc.listProductLibrary(workspace.id)).find((p) => p.id === bottle.id);
    expect(entry?.packs.map((p) => p.channels)).toEqual([["amazon.main"], CHANNELS]);
  });
});

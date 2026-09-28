import { describe, expect, it } from "vitest";
import { isShotMethodDeliverable, tierByKey } from "@curvi/pipeline/seed";
import { isMarketplaceSpec } from "@curvi/specs";
import { estimatePackCredits } from "@/lib/pack-estimate";
import { DEMO_TIER, DemoService, DemoStore } from "./demo";
import { planDemoShots } from "./demo-plan";
import type { JobStatus, JobView } from "./types";

const FIXED_NOW = () => new Date("2026-09-27T12:00:00.000Z");
const CHANNELS = ["amazon.main", "shopify.product", "meta.feed_1x1"];

function service(): DemoService {
  return new DemoService(new DemoStore(), FIXED_NOW);
}

async function createJob(svc: DemoService, key = "key-1"): Promise<JobView> {
  const workspace = await svc.getCurrentWorkspace();
  const products = await svc.listProducts(workspace.id);
  const result = await svc.createJob(workspace.id, {
    productId: products[0].id,
    channels: CHANNELS,
    mode: "listing",
    idempotencyKey: key,
  });
  if (result.outcome !== "created") {
    throw new Error(`expected created, got ${result.outcome}`);
  }
  return result.job;
}

async function drain(svc: DemoService, jobId: string, maxPolls = 40): Promise<JobStatus[]> {
  const workspace = await svc.getCurrentWorkspace();
  const seen: JobStatus[] = [];
  for (let i = 0; i < maxPolls; i++) {
    const job = await svc.getJob(workspace.id, jobId);
    if (!job) {
      throw new Error("job disappeared");
    }
    if (seen[seen.length - 1] !== job.status) {
      seen.push(job.status);
    }
    if (job.status === "done") {
      return seen;
    }
  }
  throw new Error(`job never finished; saw ${seen.join(" > ")}`);
}

describe("demo job simulation", () => {
  it("advances through the plan 4.4 state machine in order", async () => {
    const svc = service();
    const job = await createJob(svc);
    expect(job.status).toBe("queued");
    const states = await drain(svc, job.id);
    expect(states).toEqual(["analyzing", "planning", "generating", "qc", "packaging", "done"]);
  });

  it("is deterministic across fresh stores", async () => {
    const a = service();
    const b = service();
    const jobA = await createJob(a);
    const jobB = await createJob(b);
    expect(jobA.id).toBe(jobB.id);
    expect(jobA.creditsReserved).toBe(jobB.creditsReserved);
    expect(jobA.shots.map((s) => s.shotType)).toEqual(jobB.shots.map((s) => s.shotType));
    expect(await drain(a, jobA.id)).toEqual(await drain(b, jobB.id));
  });

  it("finishes every shot with a compliance verdict and fills the amazon main measurement", async () => {
    const svc = service();
    const job = await createJob(svc);
    await drain(svc, job.id);
    const workspace = await svc.getCurrentWorkspace();
    const finished = await svc.getJob(workspace.id, job.id);
    expect(finished?.shots.length).toBeGreaterThan(0);
    for (const shot of finished?.shots ?? []) {
      expect(shot.status).toBe("done");
      expect(shot.compliance?.pass).toBe(true);
    }
    const main = finished?.shots.find((s) => s.shotType === "amazon_main");
    expect(main?.compliance?.fillPct).toBeGreaterThan(0);
    expect(main?.compliance?.background).toEqual([255, 255, 255]);
    expect(finished?.status).toBe("done");
    expect(finished?.creditsCharged).toBe(finished?.creditsReserved);
  });

  it("reserves credits against the seed tier allowance", async () => {
    const svc = service();
    const before = (await svc.getCurrentWorkspace()).creditBalance;
    expect(before).toBe(tierByKey(DEMO_TIER).creditsPerMonth);
    const job = await createJob(svc);
    const after = (await svc.getCurrentWorkspace()).creditBalance;
    expect(after).toBe(before - job.creditsReserved);
  });
});

describe("demo idempotency", () => {
  it("replays the same job for the same key and body", async () => {
    const svc = service();
    const workspace = await svc.getCurrentWorkspace();
    const products = await svc.listProducts(workspace.id);
    const input = {
      productId: products[0].id,
      channels: CHANNELS,
      mode: "listing" as const,
      idempotencyKey: "repeat-key",
    };
    const first = await svc.createJob(workspace.id, input);
    const second = await svc.createJob(workspace.id, input);
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("replayed");
    if (first.outcome === "created" && second.outcome === "replayed") {
      expect(second.job.id).toBe(first.job.id);
    }
    expect(await svc.listRecentJobs(workspace.id)).toHaveLength(1);
  });

  it("conflicts when the same key arrives with a different body", async () => {
    const svc = service();
    const workspace = await svc.getCurrentWorkspace();
    const products = await svc.listProducts(workspace.id);
    const first = await svc.createJob(workspace.id, {
      productId: products[0].id,
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: "shared-key",
    });
    const second = await svc.createJob(workspace.id, {
      productId: products[1].id,
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: "shared-key",
    });
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("conflict");
    if (first.outcome === "created" && second.outcome === "conflict") {
      expect(second.existingJobId).toBe(first.job.id);
    }
  });

  it("rejects unknown products", async () => {
    const svc = service();
    const workspace = await svc.getCurrentWorkspace();
    const result = await svc.createJob(workspace.id, {
      productId: "00000000-0000-4000-8000-00000000dead",
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: "k",
    });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toBe("unknown_product");
    }
  });
});

describe("demo products and modes (Update.md 6.7)", () => {
  it("accepts a product made through createProduct", async () => {
    const svc = service();
    const workspace = await svc.getCurrentWorkspace();
    const product = await svc.createProduct(workspace.id, { title: "Walnut tray", mode: "listing" });
    const result = await svc.createJob(workspace.id, {
      productId: product.id,
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: "extra-product",
    });
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(result.job.productTitle).toBe("Walnut tray");
    }
  });

  it("makes a new product for a new pack, once, and replays a retry", async () => {
    const svc = service();
    const workspace = await svc.getCurrentWorkspace();
    const before = (await svc.listProducts(workspace.id)).length;
    const input = {
      productId: "new",
      channels: CHANNELS,
      mode: "listing" as const,
      idempotencyKey: "new-product",
      newProductTitle: "Copper kettle",
    };
    const first = await svc.createJob(workspace.id, input);
    const retry = await svc.createJob(workspace.id, input);
    expect(first.outcome).toBe("created");
    expect(retry.outcome).toBe("replayed");
    if (first.outcome === "created" && retry.outcome === "replayed") {
      expect(retry.job.id).toBe(first.job.id);
      expect(first.job.productTitle).toBe("Copper kettle");
    }
    expect((await svc.listProducts(workspace.id)).length).toBe(before + 1);
  });

  it("does not make a product when the pack is rejected", async () => {
    const svc = service();
    const workspace = await svc.getCurrentWorkspace();
    const before = (await svc.listProducts(workspace.id)).length;
    const result = await svc.createJob(workspace.id, {
      productId: "new",
      channels: CHANNELS,
      mode: "concept",
      idempotencyKey: "concept-new",
    });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toBe("mode_unavailable");
    }
    expect((await svc.listProducts(workspace.id)).length).toBe(before);
  });

  it("plans video and avatar shots only where the seed says they are in the plan and ship today", () => {
    const channels = ["amazon.main", "meta.feed_1x1", "video.social_9x16"];
    const VIDEO_METHODS = new Set(["video_generate", "avatar"]);
    for (const tier of ["free", "starter", "growth", "pro", "agency"] as const) {
      const shots = planDemoShots(channels, tier);
      const video = shots.filter((s) => VIDEO_METHODS.has(s.method));
      for (const shot of video) {
        // Anything planned must be deliverable, as production's hold is.
        expect(isShotMethodDeliverable(shot.method), `${tier} ${shot.type}`).toBe(true);
      }
      if (!isShotMethodDeliverable("video_generate") && !isShotMethodDeliverable("avatar")) {
        expect(video, tier).toEqual([]);
      }
    }
  });

  it("holds what production's estimate holds for the same pack on every tier", () => {
    const sets = [
      ["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1"],
      ["amazon.main", "shopify.product", "meta.feed_1x1"],
      ["meta.feed_1x1"],
      ["google.merchant.main", "pinterest.pin"],
    ];
    for (const tier of ["free", "starter", "growth", "pro", "agency"] as const) {
      for (const channels of sets) {
        const held = Math.ceil(planDemoShots(channels, tier).reduce((sum, shot) => sum + shot.credits, 0));
        expect(held, `${tier} ${channels.join(",")}`).toBe(estimatePackCredits(channels, "listing", tier).total);
      }
    }
  });

  it("refuses video channels while video is coming soon, as db mode does", async () => {
    const svc = service();
    const workspace = await svc.getCurrentWorkspace();
    const products = await svc.listProducts(workspace.id);
    const before = workspace.creditBalance;
    const result = await svc.createJob(workspace.id, {
      productId: products[0].id,
      channels: ["amazon.main", "video.social_9x16"],
      mode: "listing",
      idempotencyKey: "video-key",
    });
    expect(result).toMatchObject({ outcome: "rejected", reason: "feature_unavailable" });
    expect((await svc.getCurrentWorkspace()).creditBalance).toBe(before);
  });

  it("refuses an image spec a pack makes no files for, as db mode does", async () => {
    const svc = service();
    const workspace = await svc.getCurrentWorkspace();
    const products = await svc.listProducts(workspace.id);
    const before = workspace.creditBalance;
    const result = await svc.createJob(workspace.id, {
      productId: products[0].id,
      channels: ["amazon.main", "amazon.aplus.premium_full"],
      mode: "listing",
      idempotencyKey: "premium-key",
    });
    expect(result).toMatchObject({ outcome: "rejected", reason: "feature_unavailable" });
    expect((await svc.getCurrentWorkspace()).creditBalance).toBe(before);
  });

  it("plans no marketplace shots for a Concept pack, as the runner does", () => {
    const channels = ["amazon.main", "shopify.product", "meta.feed_1x1"];
    const listing = planDemoShots(channels, DEMO_TIER, "listing");
    const concept = planDemoShots(channels, DEMO_TIER, "concept");
    expect(listing.some((s) => s.channels.some((c) => isMarketplaceSpec(c)))).toBe(true);
    expect(concept.length).toBeGreaterThan(0);
    expect(concept.every((s) => s.channels.every((c) => !isMarketplaceSpec(c)))).toBe(true);
  });

  it("gives demo files stable ids and no download links", async () => {
    const svc = service();
    const job = await createJob(svc, "files-key");
    await drain(svc, job.id);
    const workspace = await svc.getCurrentWorkspace();
    const view = await svc.listJobFiles(workspace.id, job.id);
    expect(view?.files.length).toBeGreaterThan(0);
    expect(new Set(view?.files.map((f) => f.id)).size).toBe(view?.files.length);
    expect(view?.files.every((f) => f.downloadUrl === null)).toBe(true);
    expect(await svc.getJobFileDownload(workspace.id, job.id, view?.files[0].id ?? "")).toBeNull();
  });
});

describe("demo read only surface", () => {
  it("declines brand kit saves with a setup notice", async () => {
    const svc = service();
    const workspace = await svc.getCurrentWorkspace();
    const kit = await svc.getBrandKit(workspace.id);
    const result = await svc.saveBrandKit(workspace.id, kit);
    expect(result.ok).toBe(false);
    expect(result.notice).toContain("read only");
  });
});

describe("workspace management", () => {
  it("ensureWorkspace returns the demo workspace", async () => {
    const svc = service();
    const workspace = await svc.ensureWorkspace();
    expect(workspace.id).toBeTruthy();
    expect(workspace.creditBalance).toBeGreaterThan(0);
  });

  it("renames the workspace and rejects empty names", async () => {
    const svc = service();
    const workspace = await svc.getCurrentWorkspace();
    const renamed = await svc.renameWorkspace(workspace.id, "  Studio North  ");
    expect(renamed.ok).toBe(true);
    const after = await svc.getCurrentWorkspace();
    expect(after.name).toBe("Studio North");
    const empty = await svc.renameWorkspace(workspace.id, "   ");
    expect(empty.ok).toBe(false);
  });
});

describe("DemoService pack operations", () => {
  it("cancels a running simulation, returns its hold and stops it advancing", async () => {
    const svc = service();
    const workspace = await svc.getCurrentWorkspace();
    const job = await createJob(svc, "cancel-1");
    expect((await svc.getCurrentWorkspace()).creditBalance).toBe(workspace.creditBalance - job.creditsReserved);
    await svc.getJob(workspace.id, job.id);

    const result = await svc.cancelJob(workspace.id, job.id);
    expect(result).toMatchObject({ outcome: "canceled", refundedCredits: job.creditsReserved });
    expect((await svc.getCurrentWorkspace()).creditBalance).toBe(workspace.creditBalance);
    for (let i = 0; i < 20; i++) {
      const view = await svc.getJob(workspace.id, job.id);
      expect(view?.status).toBe("canceled");
      expect(view?.creditsCharged).toBe(0);
      expect(view?.shots.some((s) => s.status === "done")).toBe(false);
    }
    expect(await svc.cancelJob(workspace.id, job.id)).toMatchObject({ outcome: "finished" });
  });

  it("does not cancel a finished simulation and does not run shots again", async () => {
    const svc = service();
    const workspace = await svc.getCurrentWorkspace();
    const job = await createJob(svc, "cancel-2");
    await drain(svc, job.id);
    expect(await svc.cancelJob(workspace.id, job.id)).toMatchObject({ outcome: "finished" });
    expect(await svc.retryShot(workspace.id, job.id, "s01")).toMatchObject({ outcome: "rejected", reason: "demo" });
    expect(await svc.cancelJob(workspace.id, "00000000-0000-4000-8000-000000000999")).toMatchObject({
      outcome: "rejected",
      reason: "not_found",
    });
  });
});

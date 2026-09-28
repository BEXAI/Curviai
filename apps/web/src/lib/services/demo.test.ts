import { describe, expect, it } from "vitest";
import { tierByKey } from "@curvi/pipeline/seed";
import { DEMO_TIER, DemoService, DemoStore } from "./demo";
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

import { describe, expect, it } from "vitest";
import {
  MAX_WATCHED,
  PackWatch,
  WATCH_STORAGE_KEY,
  jobIdFromPath,
  loadWatch,
  packNoticeCopy,
  saveWatch,
} from "./pack-watch";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

describe("jobIdFromPath", () => {
  it("reads a pack page and nothing else", () => {
    expect(jobIdFromPath(`/app/jobs/${A}`)).toBe(A);
    expect(jobIdFromPath(`/app/jobs/${A.toUpperCase()}/`)).toBe(A);
    expect(jobIdFromPath("/app/jobs/not-a-job")).toBeNull();
    expect(jobIdFromPath("/app")).toBeNull();
    expect(jobIdFromPath(`/app/jobs/${A}/files`)).toBeNull();
    expect(jobIdFromPath(null)).toBeNull();
  });
});

describe("PackWatch", () => {
  it("notices a pack it saw running finish while the seller is elsewhere", () => {
    const watch = new PackWatch();
    expect(watch.seed([{ id: A, productTitle: "Kettle", status: "generating" }])).toEqual([]);
    expect(watch.toPoll()).toEqual([A]);
    expect(watch.observe(A, { status: "qc", title: "Kettle" })).toBeNull();
    expect(watch.observe(A, { status: "done", title: "Kettle" })).toEqual({ jobId: A, title: "Kettle", outcome: "done" });
    // Once noticed, it is no longer watched.
    expect(watch.toPoll()).toEqual([]);
  });

  it("notices a failed pack too, but not one that was canceled", () => {
    const watch = new PackWatch();
    watch.seed([
      { id: A, productTitle: "Kettle", status: "generating" },
      { id: B, productTitle: "Mug", status: "planning" },
    ]);
    expect(watch.observe(A, { status: "failed", title: "Kettle" })?.outcome).toBe("failed");
    expect(watch.observe(B, { status: "canceled", title: "Mug" })).toBeNull();
  });

  it("leaves the open pack to its board and never raises a stale notice after leaving it", () => {
    const watch = new PackWatch();
    watch.setViewing(A);
    expect(watch.toPoll()).toEqual([]);
    // The recent list says running while the page is open: not recorded.
    watch.seed([{ id: A, productTitle: "Kettle", status: "generating" }]);
    // The pack finished on screen, then the seller left.
    watch.setViewing(null);
    expect(watch.toPoll()).toEqual([A]);
    expect(watch.observe(A, { status: "done", title: "Kettle" })).toBeNull();
    expect(watch.toPoll()).toEqual([]);
  });

  it("picks up a pack the seller started and then left while it runs", () => {
    const watch = new PackWatch();
    watch.setViewing(A);
    watch.setViewing(null);
    expect(watch.observe(A, { status: "generating", title: "Kettle" })).toBeNull();
    expect(watch.observe(A, { status: "done", title: "Kettle" })?.outcome).toBe("done");
  });

  it("forgets what it saw when the seller opens the pack, even mid run", () => {
    const watch = new PackWatch();
    watch.seed([{ id: A, productTitle: "Kettle", status: "generating" }]);
    watch.setViewing(A);
    watch.setViewing(null);
    expect(watch.observe(A, { status: "done", title: "Kettle" })).toBeNull();
  });

  it("ignores finished packs in the recent list it was not watching, and notices watched ones", () => {
    const watch = new PackWatch();
    expect(watch.seed([{ id: A, productTitle: "Kettle", status: "done" }])).toEqual([]);
    expect(watch.toPoll()).toEqual([]);
    watch.seed([{ id: B, productTitle: "Mug", status: "generating" }]);
    expect(watch.seed([{ id: B, productTitle: "Mug", status: "done" }])).toEqual([
      { jobId: B, title: "Mug", outcome: "done" },
    ]);
  });

  it("drops packs the server no longer shows and caps how many it watches", () => {
    const watch = new PackWatch();
    watch.seed([{ id: A, productTitle: "Kettle", status: "generating" }]);
    watch.drop(A);
    expect(watch.toPoll()).toEqual([]);
    for (let i = 1; i <= MAX_WATCHED + 3; i += 1) {
      watch.observe(uuid(i), { status: "generating", title: `P${i}` });
    }
    expect(watch.toPoll()).toHaveLength(MAX_WATCHED);
    expect(watch.toPoll()).not.toContain(uuid(1));
    watch.clear();
    expect(watch.toPoll()).toEqual([]);
  });

  it("survives a reload through storage and ignores junk", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const watch = new PackWatch();
    watch.seed([{ id: A, productTitle: "Kettle", status: "generating" }]);
    saveWatch(storage, watch.snapshot());

    const restored = new PackWatch(loadWatch(storage));
    expect(restored.observe(A, { status: "done", title: "Kettle" })?.outcome).toBe("done");

    store.set(WATCH_STORAGE_KEY, "{not json");
    expect(loadWatch(storage)).toEqual([]);
    expect(new PackWatch([{ id: "nope", title: null, status: "generating" }]).toPoll()).toEqual([]);
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadWatch(blocked)).toEqual([]);
    expect(() => saveWatch(blocked, [])).not.toThrow();
    expect(loadWatch(null)).toEqual([]);
  });
});

describe("packNoticeCopy", () => {
  it("is plain spoken with no dashes, arrows or emojis", () => {
    for (const outcome of ["done", "failed"] as const) {
      const copy = packNoticeCopy({ jobId: A, title: "Kettle", outcome });
      for (const text of [copy.heading, copy.body, copy.action]) {
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toMatch(/[–—→←]| - |\p{Extended_Pictographic}/u);
      }
    }
    expect(packNoticeCopy({ jobId: A, title: "Kettle", outcome: "done" }).body).toContain("Kettle");
  });
});

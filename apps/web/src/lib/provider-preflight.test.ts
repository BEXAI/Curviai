import { describe, expect, it, vi } from "vitest";
import { QUOTA_OPEN_SECONDS, type RecordedProbe } from "@curvi/ai";
import { SHOT_SCENE_PAUSED } from "@curvi/trigger/pipeline-runner";
import { needsReviewNote, SCENE_PAUSED_NOTE } from "./job-copy";
import {
  evaluatePreflight,
  evaluatePreflightDetail,
  PACKS_PAUSED_COPY,
  PACKS_PAUSED_QUOTA_COPY,
  preflightCopy,
  PROBE_FRESH_MS,
  providerPreflight,
  providerPreflightDetail,
  restoreQuotaTrips,
  SCENES_PAUSED_COPY,
  type PreflightDeps,
  type PreflightTarget,
} from "./provider-preflight";
import { providerQuotaWarnings } from "./service-health";

const NOW = 10_000_000;

const TARGETS: PreflightTarget[] = [
  { name: "anthropic:claude-sonnet-5", kind: "llm", configured: true },
  { name: "gemini-image", kind: "image", configured: true },
  { name: "bfl-flux", kind: "image", configured: true },
  { name: "openai-image", kind: "image", configured: false },
  { name: "fal-birefnet", kind: "cutout", configured: true },
];

function deps(open: string[], probes: Record<string, Partial<RecordedProbe>> = {}, targets = TARGETS): PreflightDeps {
  return {
    targets,
    isOpen: async (name) => open.includes(name),
    lastProbe: (name) =>
      probes[name] ? ({ name, ok: false, status: null, latencyMs: 1, at: NOW, ...probes[name] } as RecordedProbe) : null,
    now: () => NOW,
  };
}

describe("evaluatePreflight", () => {
  it("is ok when every chain has a provider up", async () => {
    expect(await evaluatePreflight(deps([]))).toBe("ok");
    expect(await evaluatePreflight(deps(["gemini-image"]))).toBe("ok");
  });

  it("pauses packs when every configured cutout provider is behind an open breaker", async () => {
    expect(await evaluatePreflight(deps(["fal-birefnet"]))).toBe("packs_paused");
    // Packs paused wins over scenes paused.
    expect(await evaluatePreflight(deps(["fal-birefnet", "gemini-image", "bfl-flux"]))).toBe("packs_paused");
  });

  it("pauses only scenes when every configured image provider is down; unconfigured ones do not count", async () => {
    expect(await evaluatePreflight(deps(["gemini-image", "bfl-flux"]))).toBe("scenes_paused");
  });

  it("counts a fresh probe that refused the key or found no credit, not an old one or a network blip", async () => {
    expect(await evaluatePreflight(deps(["gemini-image"], { "bfl-flux": { status: 403 } }))).toBe("scenes_paused");
    expect(await evaluatePreflight(deps(["gemini-image"], { "bfl-flux": { status: 402 } }))).toBe("scenes_paused");
    expect(
      await evaluatePreflight(deps(["gemini-image"], { "bfl-flux": { status: 403, at: NOW - PROBE_FRESH_MS - 1 } })),
    ).toBe("ok");
    expect(await evaluatePreflight(deps(["gemini-image"], { "bfl-flux": { status: 503 } }))).toBe("ok");
    expect(await evaluatePreflight(deps(["gemini-image"], { "bfl-flux": { status: null } }))).toBe("ok");
    expect(await evaluatePreflight(deps(["gemini-image"], { "bfl-flux": { ok: true, status: 200 } }))).toBe("ok");
  });

  it("stays ok with nothing configured (demo mode) and when the breaker read fails", async () => {
    const none = TARGETS.map((t) => ({ ...t, configured: false }));
    expect(await evaluatePreflight(deps(["fal-birefnet"], {}, none))).toBe("ok");
    const broken: PreflightDeps = { ...deps([]), isOpen: async () => Promise.reject(new Error("store down")) };
    expect(await evaluatePreflight(broken)).toBe("ok");
  });

  it("gives plain copy for each verdict", () => {
    expect(preflightCopy("ok")).toBeNull();
    expect(preflightCopy("packs_paused")).toBe(PACKS_PAUSED_COPY);
    expect(preflightCopy("scenes_paused")).toBe(SCENES_PAUSED_COPY);
    for (const copy of [PACKS_PAUSED_COPY, SCENES_PAUSED_COPY]) {
      expect(copy).not.toMatch(/[‒-―]| - |->|=>/);
    }
  });

  it("providerPreflight accepts injected deps and never throws", async () => {
    expect(await providerPreflight({ ...deps(["fal-birefnet"]) })).toBe("packs_paused");
    expect(await providerPreflight({ targets: [], isOpen: async () => true, lastProbe: () => null, now: () => NOW })).toBe("ok");
  });
});

describe("pause cause", () => {
  function withReasons(reasons: Record<string, "quota" | "failures" | null>, probes: Record<string, Partial<RecordedProbe>> = {}) {
    return { ...deps([], probes), openReason: async (name: string) => reasons[name] ?? null };
  }

  it("is quota when the only cutout provider tripped for quota, with copy that makes no time promise", async () => {
    const detail = await evaluatePreflightDetail(withReasons({ "fal-birefnet": "quota" }));
    expect(detail).toEqual({ verdict: "packs_paused", cause: "quota" });
    expect(preflightCopy(detail.verdict, detail.cause)).toBe(PACKS_PAUSED_QUOTA_COPY);
    expect(PACKS_PAUSED_QUOTA_COPY).not.toContain("few minutes");
    expect(PACKS_PAUSED_QUOTA_COPY).toContain("Nothing will be charged.");
  });

  it("is failures for a failure trip, which keeps the few minutes wording", async () => {
    const detail = await evaluatePreflightDetail(withReasons({ "fal-birefnet": "failures" }));
    expect(detail).toEqual({ verdict: "packs_paused", cause: "failures" });
    expect(preflightCopy(detail.verdict, detail.cause)).toBe(PACKS_PAUSED_COPY);
  });

  it("counts a fresh account refusal probe as quota", async () => {
    const detail = await evaluatePreflightDetail(withReasons({}, { "fal-birefnet": { status: 402 } }));
    expect(detail).toEqual({ verdict: "packs_paused", cause: "quota" });
  });

  it("is ok with no cause while a provider is up", async () => {
    expect(await evaluatePreflightDetail(withReasons({}))).toEqual({ verdict: "ok", cause: null });
  });
});

describe("restoreQuotaTrips", () => {
  const cutoutTargets = TARGETS;

  function fakeBreaker(open: string[] = []) {
    const trips: Array<[string, number]> = [];
    return {
      trips,
      breaker: {
        isOpen: async (name: string) => open.includes(name),
        tripForQuota: async (name: string, seconds?: number) => {
          trips.push([name, seconds ?? -1]);
        },
      },
    };
  }

  it("opens the breaker again for the time left after a restart forgot a recent quota answer", async () => {
    const { breaker, trips } = fakeBreaker();
    const at = NOW - 10 * 60_000;
    const restored = await restoreQuotaTrips(breaker, cutoutTargets, async () => new Map([["fal-birefnet", at]]), NOW);
    expect(restored).toEqual(["fal-birefnet"]);
    expect(trips).toEqual([["fal-birefnet", QUOTA_OPEN_SECONDS - 600]]);
  });

  it("leaves an old event, an open breaker and unconfigured providers alone", async () => {
    const old = fakeBreaker();
    await restoreQuotaTrips(
      old.breaker,
      cutoutTargets,
      async () => new Map([["fal-birefnet", NOW - QUOTA_OPEN_SECONDS * 1000 - 1]]),
      NOW,
    );
    expect(old.trips).toEqual([]);

    const open = fakeBreaker(["fal-birefnet"]);
    await restoreQuotaTrips(open.breaker, cutoutTargets, async () => new Map([["fal-birefnet", NOW]]), NOW);
    expect(open.trips).toEqual([]);

    const none = fakeBreaker();
    let asked = false;
    await restoreQuotaTrips(
      none.breaker,
      TARGETS.map((t) => ({ ...t, configured: false })),
      async () => {
        asked = true;
        return new Map();
      },
      NOW,
    );
    expect(asked).toBe(false);
  });

  it("never throws when the events read fails", async () => {
    const { breaker } = fakeBreaker();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await restoreQuotaTrips(breaker, cutoutTargets, async () => Promise.reject(new Error("db down")), NOW)).toEqual([]);
  });

  it("providerPreflightDetail restores the trip before it evaluates", async () => {
    const store = new Map<string, "quota">();
    const detail = await providerPreflightDetail({
      targets: cutoutTargets,
      openReason: async (name) => store.get(name) ?? null,
      lastProbe: () => null,
      now: () => NOW,
      readRecentQuota: async (providers) => {
        // The real reader trips the process breaker; here the fake store
        // stands in for it.
        for (const name of providers) store.set(name, "quota");
        return new Map();
      },
    });
    expect(detail).toEqual({ verdict: "packs_paused", cause: "quota" });
  });
});

describe("providerQuotaWarnings", () => {
  it("lists provider_quota:<name> only for breakers a quota answer opened", async () => {
    const reasons: Record<string, "quota" | "failures" | null> = { a: "quota", b: "failures", c: null, d: "quota" };
    const warnings = await providerQuotaWarnings(["a", "b", "c", "d", "e"], {
      openReason: async (name) => {
        if (name === "e") throw new Error("store down");
        return reasons[name] ?? null;
      },
    });
    expect(warnings).toEqual(["provider_quota:a", "provider_quota:d"]);
  });
});

describe("paused scene copy", () => {
  it("maps the runner's paused reason to plain seller copy that says nothing was charged", () => {
    const note = needsReviewNote(SHOT_SCENE_PAUSED);
    expect(note.startsWith(SCENE_PAUSED_NOTE)).toBe(true);
    expect(note).toContain("No credits were charged for it.");
  });
});

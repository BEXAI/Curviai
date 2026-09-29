import { describe, expect, it } from "vitest";
import type { RecordedProbe } from "@curvi/ai";
import { SHOT_SCENE_PAUSED } from "@curvi/trigger/pipeline-runner";
import { needsReviewNote, SCENE_PAUSED_NOTE } from "./job-copy";
import {
  evaluatePreflight,
  PACKS_PAUSED_COPY,
  preflightCopy,
  PROBE_FRESH_MS,
  providerPreflight,
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

import { describe, expect, it } from "vitest";
import { InMemoryBreakerStore, InMemoryCostMeter, ProviderRegistry, type RoutingTable } from "@curvi/ai";
import { MockProvider } from "@curvi/ai/testing";
import { encodePng, type RawImage } from "@curvi/pipeline";
import { recipeSeedRows } from "@curvi/pipeline/seed";
import { runBrandPalette } from "./brand-palette";
import { InMemoryJobStore, systemClock, type PipelineDeps, type ShotGenerator } from "./pipeline-runner";

// docs/phases/PHASE_16.md workstream 7, runner side: the pixels decide a
// simple logo with no model call; only an ambiguous one asks the seeded
// namer through @curvi/ai, and only measured colors survive its answer.

const WS = "0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d";
const KEY = `ws/${WS}/src/logo.png`;
const NAMER = recipeSeedRows.find((r) => r.stage === "brand" && r.active)!.key;

function canvas(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]): RawImage {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(paint(x, y), (y * width + x) * 4);
    }
  }
  return { data, width, height, channels: 4 };
}

/** Navy block and red block on a transparent canvas. */
async function simpleLogo(): Promise<Buffer> {
  return encodePng(
    canvas(400, 200, (x, y) => {
      if (y < 20 || y >= 180) return [0, 0, 0, 0];
      if (x >= 20 && x < 180) return [0x1b, 0x2a, 0x4a, 255];
      if (x >= 220 && x < 380) return [0xd7, 0x26, 0x3d, 255];
      return [0, 0, 0, 0];
    }),
  );
}

/** An orange to purple ramp: no clean palette. */
async function gradientLogo(): Promise<Buffer> {
  const from = [0xff, 0x51, 0x2f];
  const to = [0x3a, 0x1c, 0x71];
  return encodePng(
    canvas(600, 100, (x) => {
      const t = x / 599;
      return [0, 1, 2].map((i) => Math.round(from[i] + (to[i] - from[i]) * t)).concat(255) as [number, number, number, number];
    }),
  );
}

function depsWith(bytes: Buffer, namer: MockProvider): PipelineDeps {
  const registry = new ProviderRegistry();
  registry.register(namer);
  const routing: RoutingTable = { [NAMER]: [namer.name] };
  return {
    ai: { registry, routing, meter: new InMemoryCostMeter(), breakerStore: new InMemoryBreakerStore() },
    store: new InMemoryJobStore(),
    clock: systemClock,
    generator: {} as ShotGenerator,
    loadMedia: async (key) => (key === KEY ? bytes : null),
  };
}

const args = { requestId: "brand-1", workspaceId: WS, logoKey: KEY };

describe("runBrandPalette", () => {
  it("reads a simple logo from pixels alone, with no provider call", async () => {
    const namer = new MockProvider({ name: "mock-namer", tasks: [NAMER], output: { colors: [] } });
    const run = await runBrandPalette(depsWith(await simpleLogo(), namer), args);
    expect(namer.invocations).toBe(0);
    expect(run.askedVision).toBe(false);
    expect(run.costMicros).toBe(0);
    expect(run.suggestion?.source).toBe("pixels");
    expect(run.suggestion?.colors).toHaveLength(2);
  });

  it("asks the namer for an ambiguous logo and keeps only measured candidates", async () => {
    const bytes = await gradientLogo();
    // Answer with one real candidate (read below) and one invented hex.
    const probe = new MockProvider({ name: "probe", tasks: [NAMER], output: { colors: [] } });
    const first = await runBrandPalette(depsWith(bytes, probe), args);
    expect(first.askedVision).toBe(true);
    const real = first.suggestion!.colors[0].hex;
    const namer = new MockProvider({
      name: "mock-namer",
      tasks: [NAMER],
      costMicros: 1200,
      output: {
        colors: [
          { hex: real, name: "Sunset orange" },
          { hex: "#123456", name: "made up" },
        ],
      },
    });
    const run = await runBrandPalette(depsWith(bytes, namer), args);
    expect(namer.invocations).toBe(1);
    expect(run.costMicros).toBe(1200);
    expect(run.suggestion?.source).toBe("vision");
    expect(run.suggestion?.colors.map((c) => [c.hex, c.name])).toEqual([[real, "sunset orange"]]);
    // The image goes with the call, and the task is the seeded recipe key.
    expect(namer.calls[0].task).toBe(NAMER);
    expect(JSON.stringify(namer.calls[0].input)).toContain("image/jpeg");
  });

  it("keeps the pixel reading when the namer fails", async () => {
    const namer = new MockProvider({
      name: "mock-namer",
      tasks: [NAMER],
      failTimes: Infinity,
      failWith: () => new Error("provider down"),
    });
    const run = await runBrandPalette(depsWith(await gradientLogo(), namer), args);
    expect(run.askedVision).toBe(true);
    expect(run.suggestion?.source).toBe("pixels");
    expect(run.suggestion?.colors.length).toBeGreaterThan(0);
  });

  it("refuses a key outside the workspace and a file that is not an image", async () => {
    const namer = new MockProvider({ name: "mock-namer", tasks: [NAMER] });
    const foreign = await runBrandPalette(depsWith(await simpleLogo(), namer), {
      ...args,
      logoKey: "ws/11111111-2222-4333-8444-555555555555/src/logo.png",
    });
    expect(foreign.missing).toBe(true);
    const junk = await runBrandPalette(depsWith(Buffer.from("not an image"), namer), args);
    expect(junk.unreadable).toBe(true);
    expect(junk.suggestion).toBeNull();
    expect(namer.invocations).toBe(0);
  });
});

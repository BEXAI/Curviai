import { describe, expect, it } from "vitest";
import { PACK_STATUSES } from "@/lib/api-v1/schemas";
import { PACK_VIEWER_COPY } from "./copy";
import {
  initialViewerState,
  reduceViewer,
  viewerViewOf,
  type ViewerEnv,
  type ViewerEvent,
  type ViewerState,
  type ViewerUi,
} from "./state";
import { ORIGIN, PACK_ID, finishedPack, image, pack, toolOk, toolRefusal } from "./test-fixtures";

// The pack viewer's state machine and view model (PHASE_19 P19-19): awaiting
// approval, queued, running, finished, failed and link expired; the inline
// card, the carousel and the fullscreen grid; and every untrusted field
// reduced to text and curvi.ai links.

const START = Date.UTC(2026, 9, 1, 12, 0, 0);
const HOUR = 3_600_000;

function env(now = START): ViewerEnv {
  return { origin: ORIGIN, now, pollCapMs: 30 * 60_000, maxPollErrors: 3 };
}

const UI: ViewerUi = { origin: ORIGIN, fullscreen: false, maxCarousel: 8, hostOpensInApp: false };

function run(events: ViewerEvent[], now = START, from: ViewerState = initialViewerState()): ViewerState {
  return events.reduce((state, event) => reduceViewer(state, event, env(now)), from);
}

function view(state: ViewerState, ui: Partial<ViewerUi> = {}) {
  return viewerViewOf(state, PACK_VIEWER_COPY, { ...UI, ...ui });
}

describe("pack viewer states", () => {
  it("waits for the seller's go ahead until the tool input arrives", () => {
    const state = initialViewerState();
    expect(state.phase).toBe("awaiting_approval");
    expect(view(state)).toMatchObject({ heading: "Waiting for your go ahead", status: null, layout: "none", items: [] });
    const confirmed = run([{ type: "input" }]);
    expect(confirmed.phase).toBe("queued");
    expect(view(confirmed).heading).toBe("Making your images");
    expect(confirmed.polling).toBe(false);
  });

  it("goes from queued to running to finished as the results arrive, and polls until finished", () => {
    const queued = run([{ type: "input" }, { type: "result", result: toolOk(pack()) }]);
    expect(queued).toMatchObject({ phase: "queued", polling: true, pollStartedAt: START });
    expect(view(queued)).toMatchObject({ heading: "Making your images", product: "Lavender soy candle" });

    const running = run([{ type: "poll", result: toolOk(pack({ status: "generating", progress: { done: 2, total: 5 } })) }], START + 5000, queued);
    expect(running).toMatchObject({ phase: "running", polling: true, pollStartedAt: START });
    expect(view(running)).toMatchObject({ status: "2 of 5 ready", progress: { done: 2, total: 5 } });

    const planning = run([{ type: "poll", result: toolOk(pack({ status: "planning" })) }], START + 5000, queued);
    expect(planning.phase).toBe("running");
    expect(view(planning)).toMatchObject({ status: pack().message, progress: null });

    const finished = run([{ type: "poll", result: toolOk(finishedPack(2)) }], START + 10_000, running);
    expect(finished).toMatchObject({ phase: "finished", polling: false, linksAt: START + 10_000 });
    expect(view(finished)).toMatchObject({ heading: "Ready", status: finishedPack(2).message, note: null });
  });

  it("accepts every pack status the API sends", () => {
    for (const status of PACK_STATUSES) {
      const state = run([{ type: "result", result: toolOk(pack({ status, finished: ["done", "failed", "canceled"].includes(status) })) }]);
      expect(state.pack?.status, status).toBe(status);
    }
  });

  it("shows a failed pack's neutral line, a refusal's text, and the general line when there is none", () => {
    const failed = run([{ type: "result", result: toolOk(pack({ status: "failed", finished: true, error: "The pack stopped." })) }]);
    expect(failed).toMatchObject({ phase: "failed", polling: false, failure: "The pack stopped." });
    expect(view(failed)).toMatchObject({ status: "The pack stopped.", tone: "error" });

    const refused = run([{ type: "result", result: toolRefusal("This pack needs a fresh estimate. Call estimate_pack with the same photos and choices.") }]);
    expect(view(refused)).toMatchObject({
      status: "This pack needs a fresh estimate. Call estimate_pack with the same photos and choices.",
      tone: "error",
    });

    const garbled = run([{ type: "result", result: toolOk({ pack_id: "../../etc", status: "done" }) }]);
    expect(view(garbled)).toMatchObject({ status: PACK_VIEWER_COPY.unavailable, tone: "error" });
    expect(view(run([{ type: "result", result: "nonsense" }])).status).toBe(PACK_VIEWER_COPY.unavailable);
  });

  it("says nothing was charged when the host cancels before the pack starts", () => {
    const cancelled = run([{ type: "input" }, { type: "cancelled" }]);
    expect(cancelled).toMatchObject({ phase: "failed", cancelled: true });
    expect(view(cancelled)).toMatchObject({ status: PACK_VIEWER_COPY.notStarted, tone: "error" });
    // A cancel after the pack is known changes nothing.
    const known = run([{ type: "result", result: toolOk(pack()) }, { type: "cancelled" }]);
    expect(known.phase).toBe("queued");
  });

  it("marks the links expired after the hours the result gave, or when a preview fails to load", () => {
    const finished = run([{ type: "result", result: toolOk(finishedPack(1)) }]);
    expect(run([{ type: "tick" }], START + 23 * HOUR, finished).phase).toBe("finished");
    const late = run([{ type: "tick" }], START + 24 * HOUR, finished);
    expect(late.phase).toBe("expired");
    expect(view(late)).toMatchObject({ status: PACK_VIEWER_COPY.linkExpired, items: [], layout: "none", tone: "error" });
    expect(run([{ type: "link_failed" }], START, finished).phase).toBe("expired");
    // A preview error before the pack is finished means nothing yet.
    expect(run([{ type: "result", result: toolOk(pack()) }, { type: "link_failed" }]).phase).toBe("queued");
  });

  it("stops polling after three failed get_pack calls in a row, showing the refusal's text", () => {
    const queued = run([{ type: "result", result: toolOk(pack()) }]);
    const once = run([{ type: "poll_failed" }], START, queued);
    expect(once).toMatchObject({ polling: true, pollErrors: 1 });
    const recovered = run([{ type: "poll", result: toolOk(pack({ status: "generating", progress: { done: 1, total: 4 } })) }], START, once);
    expect(recovered.pollErrors).toBe(0);
    const refusal = toolRefusal("Connect Curvi again in ChatGPT and choose a workspace.");
    const gaveUp = run([{ type: "poll", result: refusal }, { type: "poll", result: refusal }, { type: "poll", result: refusal }], START, recovered);
    expect(gaveUp).toMatchObject({ phase: "running", polling: false, stopped: "errors" });
    expect(view(gaveUp).note).toBe("Connect Curvi again in ChatGPT and choose a workspace.");
    const silent = run([{ type: "poll_failed" }, { type: "poll_failed" }, { type: "poll_failed" }], START, queued);
    expect(view(silent).note).toBe(PACK_VIEWER_COPY.askAssistant);
  });

  it("stops polling at the 30 minute cap and when the host cannot call tools", () => {
    const queued = run([{ type: "result", result: toolOk(pack()) }]);
    expect(run([{ type: "tick" }], START + 29 * 60_000, queued).polling).toBe(true);
    const capped = run([{ type: "tick" }], START + 30 * 60_000, queued);
    expect(capped).toMatchObject({ polling: false, stopped: "cap" });
    expect(view(capped).note).toBe(PACK_VIEWER_COPY.askAssistant);
    expect(run([{ type: "no_bridge" }], START, queued)).toMatchObject({ polling: false, stopped: "no_bridge" });
  });

  it("polls once more for the files when create_pack replays a finished pack", () => {
    const replay = run([{ type: "result", result: toolOk(pack({ status: "done", finished: true, replayed: true })) }]);
    expect(replay).toMatchObject({ phase: "finished", polling: true });
    expect(view(replay)).toMatchObject({ heading: "Ready", layout: "none" });
    expect(run([{ type: "poll", result: toolOk(finishedPack(1)) }], START, replay).polling).toBe(false);
  });
});

describe("untrusted results", () => {
  it("keeps only preview and file links on the site origin", () => {
    const hostile = finishedPack(0, {
      images: [
        image(1, { preview_url: "https://evil.example/api/mcp/preview/x", download_url: "javascript:alert(1)" }),
        image(2, { preview_url: "http://curvi.ai/api/mcp/preview/x", download_url: "https://curvi.ai.evil.example/api/mcp/files/x" }),
        image(3, { preview_url: `${ORIGIN}/app/settings`, download_url: `${ORIGIN}/api/mcp/preview/not-a-file` }),
        image(4, { preview_url: `https://user:pass@curvi.ai/api/mcp/preview/x`, download_url: "data:text/html,hi" }),
        image(5),
      ],
    });
    const files = run([{ type: "result", result: toolOk(hostile) }]).pack!.files!;
    expect(files.map((file) => [file.previewUrl, file.downloadUrl])).toEqual([
      [null, null],
      [null, null],
      [null, null],
      [null, null],
      [`${ORIGIN}/api/mcp/preview/tok-p5`, `${ORIGIN}/api/mcp/files/tok-f5`],
    ]);
  });

  it("keeps markup and script in the product, message and error as plain, cut text", () => {
    const markup = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const state = run([
      {
        type: "result",
        result: toolOk(pack({ status: "failed", finished: true, product: `${markup}\n\u2028${"x".repeat(500)}`, error: markup, message: markup })),
      },
    ]);
    expect(state.pack!.product.startsWith('<img src=x onerror="alert(1)"><script>alert(2)</script> ')).toBe(true);
    expect(state.pack!.product.length).toBe(200);
    expect(state.failure).toBe(markup);
    expect(view(state).product).toBe(state.pack!.product);
  });

  it("drops files of unknown kinds and never gives a zip or the report a preview", () => {
    const files = run([
      {
        type: "result",
        result: toolOk(
          finishedPack(1, {
            images: [image(1), { ...image(2), kind: "video" as never }, { ...image(3), kind: "zip", preview_url: `${ORIGIN}/api/mcp/preview/z` }],
          }),
        ),
      },
    ]).pack!.files!;
    expect(files.map((file) => [file.kind, file.previewUrl !== null])).toEqual([
      ["image", true],
      ["zip", false],
    ]);
  });
});

describe("layouts", () => {
  function finishedView(n: number, ui: Partial<ViewerUi> = {}) {
    return view(run([{ type: "result", result: toolOk(finishedPack(n)) }]), ui);
  }

  it("shows one or two images as an inline card, with See all for the zip and the report", () => {
    for (const n of [1, 2]) {
      const shown = finishedView(n);
      expect(shown.layout, String(n)).toBe("card");
      expect(shown.items).toHaveLength(n);
      expect(shown.seeAll).toBe(`See all ${n + 2} files`);
      expect(shown.items[0]).toMatchObject({ title: "amazon.main", meta: "amazon-main-1.jpg", downloadUrl: `${ORIGIN}/api/mcp/files/tok-f1` });
    }
  });

  it("shows three to eight images as a carousel, and at most eight", () => {
    for (const n of [3, 5, 8]) {
      const shown = finishedView(n);
      expect(shown.layout, String(n)).toBe("carousel");
      expect(shown.items).toHaveLength(n);
      expect(shown.items.every((item) => item.kind === "image")).toBe(true);
    }
    const many = finishedView(12);
    expect(many.layout).toBe("carousel");
    expect(many.items).toHaveLength(8);
    expect(many.seeAll).toBe("See all 14 files");
  });

  it("shows every file in a grid when fullscreen, with Open in Curvi unless the host takes it", () => {
    const grid = finishedView(12, { fullscreen: true });
    expect(grid.layout).toBe("grid");
    expect(grid.items).toHaveLength(14);
    expect(grid.items.slice(-2).map((item) => [item.kind, item.title, item.previewUrl])).toEqual([
      ["zip", "pack.zip", null],
      ["report", "report.pdf", null],
    ]);
    expect(grid.seeAll).toBeNull();
    expect(grid).toMatchObject({ openInCurvi: `${ORIGIN}/app/jobs/${PACK_ID}`, showOpenButton: true });
    expect(finishedView(3, { fullscreen: true, hostOpensInApp: true }).showOpenButton).toBe(false);
  });

  it("says when some images did not pass their checks", () => {
    const state = run([{ type: "result", result: toolOk(finishedPack(0, { images: [image(1), image(2, { passes_channel_rules: false })] })) }]);
    expect(view(state).note).toBe("Some images did not pass their checks and were not charged.");
  });

  it("shows no media when the links are missing", () => {
    const state = run([
      { type: "result", result: toolOk(finishedPack(0, { images: [image(1, { preview_url: null, download_url: null })] })) },
    ]);
    expect(view(state)).toMatchObject({ layout: "none", items: [], seeAll: null });
  });
});

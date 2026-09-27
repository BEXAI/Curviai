import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  extractFrames,
  ffmpegAvailable,
  MAX_INPUT_SECONDS,
  muxAudio,
  probeDuration,
  stitchClips,
} from "./ffmpeg";

const execFileAsync = promisify(execFile);
const available = await ffmpegAvailable();

if (!available) {
  console.warn(
    "ffmpeg or ffprobe was not found on PATH. Skipping the @curvi/video ffmpeg helper tests.",
  );
}

it.runIf(!available)("reports why the ffmpeg helper tests were skipped", () => {
  expect(available).toBe(false);
});

describe.skipIf(!available)("ffmpeg helpers", () => {
  let dir: string;
  let clipPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "curvi-video-test-"));
    clipPath = join(dir, "clip.mp4");
    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=2:size=320x240:rate=30",
      "-pix_fmt",
      "yuv420p",
      clipPath,
    ]);
  });

  afterAll(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("probeDuration reads the clip length", async () => {
    const seconds = await probeDuration(clipPath);
    expect(seconds).toBeGreaterThan(1.8);
    expect(seconds).toBeLessThan(2.3);
  });

  it("probeDuration throws a readable error for a missing file", async () => {
    await expect(probeDuration(join(dir, "missing.mp4"))).rejects.toThrow(/ffprobe failed/);
  });

  it("extractFrames writes roughly fps times duration frames", async () => {
    const outDir = join(dir, "frames");
    const frames = await extractFrames(clipPath, outDir, 5);
    expect(frames.length).toBeGreaterThanOrEqual(9);
    expect(frames.length).toBeLessThanOrEqual(11);
    expect(frames[0].endsWith(".png")).toBe(true);
    const first = await stat(frames[0]);
    expect(first.size).toBeGreaterThan(0);
    const sorted = [...frames].sort();
    expect(frames).toEqual(sorted);
  });

  it("extractFrames rejects a non positive fps", async () => {
    await expect(extractFrames(clipPath, join(dir, "bad-fps"), 0)).rejects.toThrow(/fps/);
    await expect(extractFrames(clipPath, join(dir, "bad-fps"), -2)).rejects.toThrow(/fps/);
  });

  it("stitchClips concatenates two clips into one", async () => {
    const outPath = join(dir, "stitched.mp4");
    const result = await stitchClips([clipPath, clipPath], outPath);
    expect(result).toBe(outPath);
    const seconds = await probeDuration(outPath);
    expect(seconds).toBeGreaterThan(3.5);
    expect(seconds).toBeLessThan(4.6);
  });

  it("stitchClips rejects an empty input list", async () => {
    await expect(stitchClips([], join(dir, "none.mp4"))).rejects.toThrow(/at least one/);
  });

  it("muxAudio adds an audio track to a silent clip", async () => {
    const audioPath = join(dir, "tone.m4a");
    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-c:a",
      "aac",
      audioPath,
    ]);
    const outPath = join(dir, "with-audio.mp4");
    await muxAudio(clipPath, audioPath, outPath);
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "csv=p=0",
      outPath,
    ]);
    expect(stdout.trim()).toBe("audio");
    const seconds = await probeDuration(outPath);
    expect(seconds).toBeGreaterThan(1.8);
    expect(seconds).toBeLessThan(2.3);
  });

  it("rejects inputs longer than the 60 second cap", async () => {
    const longPath = join(dir, "long.mp4");
    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=61:size=160x120:rate=5",
      "-pix_fmt",
      "yuv420p",
      longPath,
    ]);
    const capPattern = new RegExp(`${MAX_INPUT_SECONDS} second cap`);
    await expect(extractFrames(longPath, join(dir, "long-frames"), 1)).rejects.toThrow(capPattern);
    await expect(stitchClips([longPath], join(dir, "long-stitch.mp4"))).rejects.toThrow(capPattern);
    await expect(muxAudio(longPath, longPath, join(dir, "long-mux.mp4"))).rejects.toThrow(capPattern);
  });
});

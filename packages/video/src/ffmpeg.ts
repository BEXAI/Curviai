import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Plan section 4.5: uploaded video is capped at 60 seconds. */
export const MAX_INPUT_SECONDS = 60;

interface ExecResult {
  stdout: string;
  stderr: string;
}

function describeExecError(binary: string, error: unknown): Error {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  ) {
    return new Error(
      `${binary} was not found on PATH. Install ffmpeg 7 to use the @curvi/video media helpers.`,
    );
  }
  const stderr =
    error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const detail = stderr.trim().split("\n").slice(-3).join(" ") || message;
  return new Error(`${binary} failed: ${detail}`);
}

async function exec(binary: "ffmpeg" | "ffprobe", args: string[]): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (error) {
    throw describeExecError(binary, error);
  }
}

/** True when both ffmpeg and ffprobe respond on PATH. */
export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    await execFileAsync("ffprobe", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

/** Read the container duration of a media file in seconds via ffprobe. */
export async function probeDuration(path: string): Promise<number> {
  const { stdout } = await exec("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Could not read a duration from ${path}`);
  }
  return seconds;
}

async function assertWithinCap(path: string): Promise<void> {
  const seconds = await probeDuration(path);
  if (seconds > MAX_INPUT_SECONDS) {
    throw new Error(
      `Input ${path} runs ${seconds.toFixed(1)} seconds, over the ${MAX_INPUT_SECONDS} second cap`,
    );
  }
}

/**
 * Extract still frames from a video at the given rate. Returns the sorted
 * absolute paths of the PNG frames that were written to outDir.
 */
export async function extractFrames(
  videoPath: string,
  outDir: string,
  fps: number,
): Promise<string[]> {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`fps must be a positive number, got ${fps}`);
  }
  await assertWithinCap(videoPath);
  await mkdir(outDir, { recursive: true });
  const pattern = join(outDir, "frame-%05d.png");
  await exec("ffmpeg", ["-y", "-i", videoPath, "-vf", `fps=${fps}`, "-f", "image2", pattern]);
  const entries = await readdir(outDir);
  return entries
    .filter((name) => /^frame-\d{5}\.png$/.test(name))
    .sort()
    .map((name) => resolve(outDir, name));
}

/**
 * Concatenate clips into one mp4, re encoding to H.264 so mixed sources
 * stitch cleanly. Audio is carried through when the sources have it.
 */
export async function stitchClips(paths: string[], outPath: string): Promise<string> {
  if (paths.length === 0) {
    throw new Error("stitchClips needs at least one input clip");
  }
  for (const path of paths) {
    await assertWithinCap(path);
  }
  const workDir = await mkdtemp(join(tmpdir(), "curvi-stitch-"));
  const listPath = join(workDir, "clips.txt");
  const lines = paths
    .map((path) => `file '${resolve(path).replaceAll("'", "'\\''")}'`)
    .join("\n");
  try {
    await writeFile(listPath, `${lines}\n`, "utf8");
    await exec("ffmpeg", [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      outPath,
    ]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  return outPath;
}

/**
 * Mux an audio track onto a video without re encoding the video stream.
 * The output stops at the shorter of the two inputs.
 */
export async function muxAudio(video: string, audio: string, out: string): Promise<string> {
  await assertWithinCap(video);
  await exec("ffmpeg", [
    "-y",
    "-i",
    video,
    "-i",
    audio,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-shortest",
    out,
  ]);
  return out;
}

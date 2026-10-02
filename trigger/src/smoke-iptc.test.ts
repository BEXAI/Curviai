import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  encodePng,
  endExiftool,
  readDigitalSourceTypeValue,
  writeDigitalSourceType,
  type RawImage,
} from "@curvi/pipeline";
import {
  checkDeliveredFile,
  describeDigitalSourceType,
  LIFESTYLE_KEY_QUERY,
  parseSmokeIptcArgs,
  SMOKE_IPTC_USAGE,
} from "./smoke-iptc";

const WS = "11111111-2222-4333-8444-555555555555";
const JOB = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const SCENE_KEY = `ws/${WS}/jobs/${JOB}/files/shopify/amber-candle-2.jpg`;

// CLAUDE.md rule 9 for what the founder reads: no emojis, no arrows, no
// dashes as punctuation.
const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--(?!filter)|\p{Extended_Pictographic}/u;

function raw(): RawImage {
  const width = 32;
  const height = 32;
  return { width, height, channels: 4, data: Buffer.alloc(width * height * 4, 180) };
}

afterAll(async () => {
  await endExiftool();
});

describe("smoke:iptc arguments", () => {
  it("accepts one delivered image key", () => {
    expect(parseSmokeIptcArgs([SCENE_KEY])).toEqual({ ok: true, key: SCENE_KEY, extension: "jpg" });
    expect(parseSmokeIptcArgs(["--", SCENE_KEY])).toMatchObject({ ok: true, key: SCENE_KEY });
    for (const key of [
      `ws/${WS}/jobs/${JOB}/files/google/main.png`,
      `ws/${WS}/jobs/${JOB}/files/meta/variation-2/feed.webp`,
      `ws/${WS}/jobs/${JOB}/files/amazon/followup-abc123/ABC123.PT01.JPEG`,
    ]) {
      expect(parseSmokeIptcArgs([key]), key).toMatchObject({ ok: true, key });
    }
    expect(parseSmokeIptcArgs([`ws/${WS}/jobs/${JOB}/files/meta/variation-2/feed.webp`])).toMatchObject({
      extension: "webp",
    });
  });

  it("prints the usage with no key or a help flag", () => {
    for (const argv of [[], ["--"], ["--help"], ["-h"]]) {
      expect(parseSmokeIptcArgs(argv)).toEqual({ ok: false, message: SMOKE_IPTC_USAGE });
    }
  });

  it("refuses more than one key", () => {
    const parsed = parseSmokeIptcArgs([SCENE_KEY, SCENE_KEY]);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.message).toMatch(/^Give exactly one object key, not 2\./);
  });

  it("refuses anything that is not a delivered image", () => {
    for (const key of [
      `/ws/${WS}/jobs/${JOB}/files/shopify/scene.jpg`,
      `ws/${WS}/jobs/${JOB}/pack/shopify.zip`,
      `ws/${WS}/jobs/${JOB}/pack/compliance-report.json`,
      `ws/${WS}/jobs/${JOB}/files/shopify/scene.gif`,
      `ws/${WS}/jobs/${JOB}/files/shopify/../../../other/scene.jpg`,
      `ws/${WS}/jobs/${JOB}/files/shopify/a/b/scene.jpg`,
      `ws/${WS}/uploads/photo.jpg`,
      `ws/not-a-uuid/jobs/${JOB}/files/shopify/scene.jpg`,
      `ws\\${WS}\\jobs\\${JOB}\\files\\shopify\\scene.jpg`,
      `ws/${WS}/jobs/${JOB}/files/shopify/${"x".repeat(600)}.jpg`,
    ]) {
      expect(parseSmokeIptcArgs([key]).ok, key).toBe(false);
    }
  });

  it("tells the founder where to find a key, in plain words", () => {
    expect(SMOKE_IPTC_USAGE).toContain(LIFESTYLE_KEY_QUERY);
    expect(LIFESTYLE_KEY_QUERY).toMatch(/^select v\.r2_key from asset_variants/);
    for (const text of [
      SMOKE_IPTC_USAGE,
      describeDigitalSourceType(null),
      describeDigitalSourceType("http://cv.iptc.org/newscodes/digitalsourcetype/compositeSynthetic"),
      describeDigitalSourceType("http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"),
      describeDigitalSourceType("http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture"),
    ]) {
      expect(text).not.toMatch(FORBIDDEN_COPY);
    }
  });
});

describe("smoke:iptc read", () => {
  it("prints the label of a tagged scene read through exiftool, and deletes its copy", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "curvi-smoke-test-"));
    const source = path.join(work, "scene.png");
    await writeFile(source, await encodePng(raw()));
    await writeDigitalSourceType(source, "composite");
    const bytes = await readFile(source);
    const tempRoot = await mkdtemp(path.join(tmpdir(), "curvi-smoke-root-"));
    const asked: string[] = [];

    const result = await checkDeliveredFile(
      { key: SCENE_KEY.replace(/\.jpg$/, ".png"), extension: "png" },
      {
        get: async (key) => {
          asked.push(key);
          return bytes;
        },
        readValue: readDigitalSourceTypeValue,
        tempRoot,
      },
    );

    expect(asked).toEqual([SCENE_KEY.replace(/\.jpg$/, ".png")]);
    expect(result.ok).toBe(true);
    expect(result.value).toBe("http://cv.iptc.org/newscodes/digitalsourcetype/compositeSynthetic");
    expect(result.lines).toContain(
      "DigitalSourceType: http://cv.iptc.org/newscodes/digitalsourcetype/compositeSynthetic",
    );
    expect(result.lines).toContain(`Size: ${bytes.length} bytes`);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("says none for an untagged file", async () => {
    const result = await checkDeliveredFile(
      { key: SCENE_KEY, extension: "jpg" },
      { get: async () => Buffer.from("bytes"), readValue: async () => null },
    );
    expect(result.ok).toBe(true);
    expect(result.lines).toContain("DigitalSourceType: none");
    expect(result.lines).toContain(describeDigitalSourceType(null));
  });

  it("fails without throwing when the object cannot be read", async () => {
    for (const get of [async () => null, async () => Promise.reject(new Error("socket hang up"))]) {
      const result = await checkDeliveredFile(
        { key: SCENE_KEY, extension: "jpg" },
        { get, readValue: async () => "never called" },
      );
      expect(result.ok).toBe(false);
      expect(result.value).toBeNull();
      expect(result.lines[0]).toBe(`Could not read ${SCENE_KEY}.`);
    }
  });

  it("fails without throwing when exiftool cannot read the copy, and still deletes it", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "curvi-smoke-root-"));
    const result = await checkDeliveredFile(
      { key: SCENE_KEY, extension: "jpg" },
      {
        get: async () => Buffer.from("bytes"),
        readValue: async () => {
          throw new Error("not an image");
        },
        tempRoot,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toBe("exiftool could not read the file: not an image");
    expect(await readdir(tempRoot)).toEqual([]);
  });
});

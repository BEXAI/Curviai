import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { endExiftool, readDigitalSourceType, writeDigitalSourceType } from "./iptc";

async function tempJpeg(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "curvi-iptc-"));
  const file = path.join(dir, name);
  const jpeg = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 200, b: 200 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  await writeFile(file, jpeg);
  return file;
}

afterAll(async () => {
  await endExiftool();
});

describe("digital source type roundtrip", () => {
  it("writes and reads compositeSynthetic", async () => {
    const file = await tempJpeg("composite.jpg");
    await writeDigitalSourceType(file, "composite");
    expect(await readDigitalSourceType(file)).toBe("composite");
  });

  it("writes and reads trainedAlgorithmicMedia", async () => {
    const file = await tempJpeg("trained.jpg");
    await writeDigitalSourceType(file, "trained");
    expect(await readDigitalSourceType(file)).toBe("trained");
  });

  it("reports none for an untagged file", async () => {
    const file = await tempJpeg("plain.jpg");
    expect(await readDigitalSourceType(file)).toBe("none");
  });

  it("removes the tag for kind none", async () => {
    const file = await tempJpeg("cleared.jpg");
    await writeDigitalSourceType(file, "trained");
    expect(await readDigitalSourceType(file)).toBe("trained");
    await writeDigitalSourceType(file, "none");
    expect(await readDigitalSourceType(file)).toBe("none");
  });
});

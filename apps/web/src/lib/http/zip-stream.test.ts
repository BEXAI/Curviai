import { Readable } from "node:stream";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { zipStream, type OpenEntryStream } from "./zip-stream";

/** Reads a zip's entries back through its central directory. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThanOrEqual(0);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(dataAt, dataAt + compressed);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

async function collect(stream: ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const CONTENT: Record<string, Buffer> = {
  "k/main.jpg": Buffer.alloc(300_000, 1),
  "k/alt.jpg": Buffer.alloc(200_000, 2),
  "k/report.pdf": Buffer.from("%PDF report"),
};

describe("zipStream", () => {
  it("zips every entry under its name, opening each file only after the last one is written", async () => {
    let open = 0;
    let maxOpen = 0;
    const order: string[] = [];
    const opener: OpenEntryStream = async (source) => {
      order.push(source);
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      // Small chunks, so each file takes several reads to drain.
      const bytes = CONTENT[source];
      const chunks = Array.from({ length: Math.ceil(bytes.length / 16_384) }, (_, i) => bytes.subarray(i * 16_384, (i + 1) * 16_384));
      const stream = Readable.from(chunks);
      stream.once("end", () => {
        open -= 1;
      });
      return stream;
    };
    const onError = vi.fn();
    const zip = await collect(
      zipStream(
        [
          { name: "amazon/MAIN.jpg", source: "k/main.jpg" },
          { name: "amazon/ALT.jpg", source: "k/alt.jpg" },
          { name: "report.pdf", source: "k/report.pdf" },
        ],
        opener,
        onError,
      ),
    );

    expect(order).toEqual(["k/main.jpg", "k/alt.jpg", "k/report.pdf"]);
    expect(maxOpen).toBe(1);
    expect(onError).not.toHaveBeenCalled();
    const files = unzip(zip);
    expect([...files.keys()]).toEqual(["amazon/MAIN.jpg", "amazon/ALT.jpg", "report.pdf"]);
    expect(files.get("amazon/MAIN.jpg")?.equals(CONTENT["k/main.jpg"])).toBe(true);
    expect(files.get("amazon/ALT.jpg")?.equals(CONTENT["k/alt.jpg"])).toBe(true);
    expect(files.get("report.pdf")?.toString()).toBe("%PDF report");
  });

  it("ends the download with an error when a file vanished part way, never a short zip", async () => {
    const opened: string[] = [];
    const opener: OpenEntryStream = async (source) => {
      opened.push(source);
      return source === "k/alt.jpg" ? null : Readable.from([CONTENT[source]]);
    };
    const onError = vi.fn();
    await expect(
      collect(
        zipStream(
          [
            { name: "a/MAIN.jpg", source: "k/main.jpg" },
            { name: "a/ALT.jpg", source: "k/alt.jpg" },
            { name: "report.pdf", source: "k/report.pdf" },
          ],
          opener,
          onError,
        ),
      ),
    ).rejects.toThrow();
    expect(opened).toEqual(["k/main.jpg", "k/alt.jpg"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toMatch(/k\/alt\.jpg/);
  });

  it("ends the download with an error when a storage read fails mid stream", async () => {
    const opener: OpenEntryStream = async () =>
      new Readable({
        read() {
          this.destroy(new Error("storage reset"));
        },
      });
    const onError = vi.fn();
    await expect(collect(zipStream([{ name: "a.jpg", source: "k/a.jpg" }], opener, onError))).rejects.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("stops opening files once the download is cancelled", async () => {
    const opened: string[] = [];
    const opener: OpenEntryStream = async (source) => {
      opened.push(source);
      return Readable.from([Buffer.alloc(2_000_000, 7)]);
    };
    const onError = vi.fn();
    const stream = zipStream(
      [
        { name: "1.bin", source: "k/1" },
        { name: "2.bin", source: "k/2" },
        { name: "3.bin", source: "k/3" },
      ],
      opener,
      onError,
    );
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(opened.length).toBeLessThan(3);
    expect(onError).not.toHaveBeenCalled();
  });
});

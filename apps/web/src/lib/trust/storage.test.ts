import { beforeEach, describe, expect, it, vi } from "vitest";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { MemoryTrustStorage, r2TrustStorage } from "./storage";
const send = vi.hoisted(() => vi.fn());
vi.mock("@/lib/r2", () => ({ r2Client: () => ({ send }), privateBucket: () => "unit-test-bucket" }));
beforeEach(() => { send.mockReset(); });

describe("paged trust storage", () => {
  it("preserves the opaque provider cursor and caps each request at 1000 objects", async () => {
    send.mockResolvedValueOnce({ IsTruncated: true, NextContinuationToken: "opaque+/==", Contents: [{ Key: "ws/a/src/first", Size: 4 }] });
    const storage = r2TrustStorage();
    expect(await storage.listPage("ws/a/src/", 5000, "previous+/==")).toEqual({
      objects: [{ key: "ws/a/src/first", bytes: 4, lastModified: null }], continuationToken: "opaque+/==",
    });
    const [command, options] = send.mock.calls[0];
    expect(command).toBeInstanceOf(ListObjectsV2Command);
    expect(command.input).toEqual({ Bucket: "unit-test-bucket", Prefix: "ws/a/src/", ContinuationToken: "previous+/==", MaxKeys: 1000 });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("distinguishes an exhausted exact-size page from a truncated page and refuses missing cursors", async () => {
    send.mockResolvedValueOnce({ IsTruncated: false, Contents: [{ Key: "first" }] });
    expect((await r2TrustStorage().listPage("prefix", 1)).continuationToken).toBeNull();
    send.mockResolvedValueOnce({ IsTruncated: true, Contents: [{ Key: "first" }] });
    await expect(r2TrustStorage().listPage("prefix", 1)).rejects.toThrow("without a cursor");
  });

  it("keeps the existing full-list API and obeys the remaining allowance on the next page", async () => {
    send.mockResolvedValueOnce({ IsTruncated: true, NextContinuationToken: "next", Contents: [{ Key: "first" }, { Key: "second" }] })
      .mockResolvedValueOnce({ IsTruncated: true, NextContinuationToken: "later", Contents: [{ Key: "third" }] });
    expect((await r2TrustStorage().list("prefix", 3)).map((object) => object.key)).toEqual(["first", "second", "third"]);
    expect(send.mock.calls[1][0].input).toMatchObject({ ContinuationToken: "next", MaxKeys: 1 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("returns every key in a timed-out delete batch as retryable and uses an abortable request", async () => {
    send.mockRejectedValueOnce(new Error("simulated timeout"));
    expect(await r2TrustStorage().deleteMany(["one", "two"])).toEqual(["one", "two"]);
    expect(send.mock.calls[0][1].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("resumes memory pages by key even when an earlier page was deleted", async () => {
    const storage = new MemoryTrustStorage();
    for (const key of ["p/c", "p/a", "p/b"]) storage.seed(key, Buffer.from(key));
    const first = await storage.listPage("p/", 2);
    expect(first.objects.map((object) => object.key)).toEqual(["p/a", "p/b"]);
    await storage.deleteMany(first.objects.map((object) => object.key));
    expect((await storage.listPage("p/", 2, first.continuationToken)).objects.map((object) => object.key)).toEqual(["p/c"]);
  });
});

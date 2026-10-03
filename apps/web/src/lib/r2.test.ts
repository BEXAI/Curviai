import { afterEach, describe, expect, it, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import {
  PREVIEW_SIGNING_WINDOW_SECONDS,
  attachmentDisposition,
  getObjectBytesBounded,
  isWorkspaceKey,
  presignDownload,
  presignObjectGet,
  previewSigningDate,
} from "./r2";

const R2_ENV = { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret" };

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of Object.keys(R2_ENV)) {
    delete process.env[name];
  }
});

describe("bounded report reads", () => {
  it("caps actual streamed bytes even when Content-Length is absent", async () => {
    Object.assign(process.env, R2_ENV);
    const canceled = vi.fn();
    vi.spyOn(S3Client.prototype, "send").mockResolvedValue({ Body: { transformToWebStream: () => new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(6)); }, cancel: canceled,
    }) } } as never);
    await expect(getObjectBytesBounded("report.json", 5, new AbortController().signal)).rejects.toThrow("byte limit");
    expect(canceled).toHaveBeenCalled();
  });

  it("aborts a stalled response stream and passes the signal to the GET", async () => {
    Object.assign(process.env, R2_ENV);
    const controller = new AbortController();
    const canceled = vi.fn();
    const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({ Body: {
      transformToWebStream: () => new ReadableStream({ cancel: canceled }),
    } } as never);
    const reading = getObjectBytesBounded("report.json", 5, controller.signal);
    await Promise.resolve();
    controller.abort(new Error("report read timed out"));
    await expect(reading).rejects.toThrow("report read timed out");
    expect(send).toHaveBeenCalledWith(expect.anything(), { abortSignal: controller.signal });
    expect(canceled).toHaveBeenCalled();
  });
});

describe("attachmentDisposition", () => {
  it("saves under the delivered file name", () => {
    expect(attachmentDisposition("MUG1.MAIN.jpg")).toBe(
      "attachment; filename=\"MUG1.MAIN.jpg\"; filename*=UTF-8''MUG1.MAIN.jpg",
    );
  });

  it("keeps quotes and non ASCII out of the plain filename", () => {
    const value = attachmentDisposition('café "mug".jpg');
    expect(value).toContain('filename="caf_ _mug_.jpg"');
    expect(value).toContain("filename*=UTF-8''caf%C3%A9%20%22mug%22.jpg");
  });
});

describe("isWorkspaceKey", () => {
  it("accepts only keys under the workspace prefix", () => {
    expect(isWorkspaceKey("w1", "ws/w1/jobs/j/files/amazon/a.jpg")).toBe(true);
    expect(isWorkspaceKey("w1", "ws/w2/jobs/j/files/amazon/a.jpg")).toBe(false);
    expect(isWorkspaceKey("w1", "ws/w1/../w2/a.jpg")).toBe(false);
  });
});

describe("preview signing", () => {
  it("rounds to the start of the signing window", () => {
    const windowMs = PREVIEW_SIGNING_WINDOW_SECONDS * 1000;
    const date = previewSigningDate(new Date(windowMs * 10 + 12_345));
    expect(date.getTime()).toBe(windowMs * 10);
  });

  it("signs the same preview url twice in one window, so polling hits the browser cache", async () => {
    Object.assign(process.env, R2_ENV);
    const a = await presignObjectGet("ws/w1/jobs/j/files/amazon/a.jpg");
    const b = await presignObjectGet("ws/w1/jobs/j/files/amazon/a.jpg");
    expect(a).toBe(b);
    const expires = Number(new URL(a).searchParams.get("X-Amz-Expires"));
    expect(expires).toBe(3600 + PREVIEW_SIGNING_WINDOW_SECONDS);
  });

  it("names the file in a signed download url", async () => {
    Object.assign(process.env, R2_ENV);
    const url = new URL(await presignDownload("ws/w1/jobs/j/files/amazon/a.jpg", "MUG1.MAIN.jpg"));
    expect(url.searchParams.get("response-content-disposition")).toContain('filename="MUG1.MAIN.jpg"');
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBe(900);
  });
});

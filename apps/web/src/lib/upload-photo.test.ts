import { afterEach, describe, expect, it, vi } from "vitest";
import { PHOTO_ACCEPT, PHOTO_TYPE_REFUSED, uploadSourcePhoto } from "./upload-photo";
import { ALLOWED_IMAGE_CONTENT_TYPES } from "./upload-validation";

// The pack page's "Add this photo" upload offers and accepts exactly the
// image types the sign route takes, so a HEIC or AVIF file never reaches the
// route and comes back as a raw MIME list.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadSourcePhoto", () => {
  it("offers only the types the sign route allows", () => {
    expect(PHOTO_ACCEPT.split(",")).toEqual([...ALLOWED_IMAGE_CONTENT_TYPES]);
  });

  it.each(["image/heic", "image/avif", "application/pdf", ""])("refuses %j with plain copy before signing", async (type) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await uploadSourcePhoto(new File(["x"], "photo", { type }));
    expect(result).toEqual({ ok: false, message: PHOTO_TYPE_REFUSED });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signs and uploads an allowed photo", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://r2.example/put", key: "ws/w/src/a" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await uploadSourcePhoto(new File(["x"], "photo.webp", { type: "image/webp" }));
    expect(result).toMatchObject({ ok: true, key: "ws/w/src/a" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * Browser side photo upload for the pack page's "Add this photo" action:
 * sign through /api/uploads/sign, PUT the file to storage, and hand back the
 * key and sha256 the photo route records. The same steps the new pack form
 * takes, returned as one result the caller renders.
 */

import { ALLOWED_IMAGE_CONTENT_TYPES, UNSUPPORTED_PHOTO_COPY, uploadTypeForFile } from "@/lib/upload-validation";

export type PhotoUploadResult =
  | { ok: true; key: string; sha256: string }
  | { ok: false; message: string };

export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The file picker's accept list: exactly the image types the sign route
 * takes, so a HEIC or AVIF file is not offered and then refused. */
export const PHOTO_ACCEPT = ALLOWED_IMAGE_CONTENT_TYPES.join(",");

/** Plain copy for a file the sign route would refuse. */
export const PHOTO_TYPE_REFUSED = UNSUPPORTED_PHOTO_COPY;

export async function uploadSourcePhoto(file: File): Promise<PhotoUploadResult> {
  // An empty type is read from the file name; HEIC and friends get plain copy.
  const type = uploadTypeForFile(file, { allowVideo: false });
  if (!type.ok) {
    return { ok: false, message: PHOTO_TYPE_REFUSED };
  }
  try {
    const response = await fetch("/api/uploads/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "image", contentType: type.contentType, bytes: file.size }),
    });
    const data = (await response.json().catch(() => ({}))) as { url?: string; key?: string; error?: string };
    if (response.status === 503) {
      return { ok: false, message: "Photo uploads are not available on this server yet." };
    }
    if (!response.ok || !data.url || !data.key) {
      return { ok: false, message: data.error ?? "The upload could not be signed. Try again." };
    }
    const put = await fetch(data.url, { method: "PUT", headers: { "Content-Type": type.contentType }, body: file });
    if (!put.ok) {
      return { ok: false, message: "The upload failed. Try again." };
    }
    return { ok: true, key: data.key, sha256: await sha256Hex(file) };
  } catch {
    return { ok: false, message: "The upload failed. Check your connection and try again." };
  }
}

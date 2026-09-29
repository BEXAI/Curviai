/**
 * Browser side photo upload for the pack page's "Add this photo" action:
 * sign through /api/uploads/sign, PUT the file to storage, and hand back the
 * key and sha256 the photo route records. The same steps the new pack form
 * takes, returned as one result the caller renders.
 */

import { uploadTypeForFile } from "@/lib/upload-validation";

export type PhotoUploadResult =
  | { ok: true; key: string; sha256: string }
  | { ok: false; message: string };

export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function uploadSourcePhoto(file: File): Promise<PhotoUploadResult> {
  // The picker accepts image/*, so HEIC and friends get plain copy here, and
  // an empty type is read from the file name.
  const type = uploadTypeForFile(file, { allowVideo: false });
  if (!type.ok) {
    return { ok: false, message: type.message };
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

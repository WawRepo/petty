/**
 * Downscale + re-encode a photo through a canvas (spec "Storage shape"):
 * ≤ 1000 px on the long edge, JPEG, quality stepped down until ≤ 300 KB.
 * Re-encoding drops EXIF — including GPS — by construction, and that is the
 * point, not a side effect: the bytes that leave this function never carry it.
 */
import { PHOTO_MAX_BYTES } from "@petty/protocol"; // shared with the API, which refuses a bigger sealed photo (PETTY-243)

export const PHOTO_MAX_EDGE = 1000;

export async function processPhoto(file: Blob): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.drawImage(bitmap, 0, 0, w, h);
    for (const quality of [0.75, 0.6, 0.45, 0.3]) {
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", quality));
      if (!blob) throw new Error("encode failed");
      if (blob.size <= PHOTO_MAX_BYTES) return new Uint8Array(await blob.arrayBuffer());
    }
    throw new Error("photo too large after re-encoding");
  } finally {
    bitmap.close();
  }
}

/** In-memory object URL for decrypted JPEG bytes. Revoke it when the drawer view goes away. */
export function photoUrl(bytes: Uint8Array): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
}

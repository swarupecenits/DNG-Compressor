/** Small square thumbnails from a DNG's embedded JPEG preview. */

import type { PreviewRef } from "./lib/dng.ts";

/** JPEG headers (Exif, ICC, tables) normally fit well within this. */
const HEADER_BYTES = 256 * 1024;

/** Canvas transforms for TIFF orientations 1–8 on a unit square: a, b, c, d, e, f. */
const ORIENTATIONS: Record<number, readonly [number, number, number, number, number, number]> = {
  1: [1, 0, 0, 1, 0, 0],
  2: [-1, 0, 0, 1, 1, 0],
  3: [-1, 0, 0, -1, 1, 1],
  4: [1, 0, 0, -1, 0, 1],
  5: [0, 1, 1, 0, 0, 0],
  6: [0, 1, -1, 0, 1, 0],
  7: [0, -1, -1, 0, 1, 1],
  8: [0, -1, 1, 0, 0, 1],
};

function isExif(bytes: Uint8Array, at: number): boolean {
  const tag = [0x45, 0x78, 0x69, 0x66, 0, 0];
  return tag.every((byte, i) => bytes[at + i] === byte);
}

/**
 * The preview JPEG without its Exif segments. The DNG's own Orientation tag is
 * authoritative (rotating a DNG only rewrites that tag), so the JPEG's copy must
 * not be applied as well.
 */
async function previewWithoutExif(file: Blob, preview: PreviewRef): Promise<Blob | null> {
  const start = preview.offset;
  const end = preview.offset + preview.length;
  const head = new Uint8Array(await file.slice(start, Math.min(end, start + HEADER_BYTES)).arrayBuffer());
  if (head[0] !== 0xff || head[1] !== 0xd8) return null;
  const parts: Blob[] = [];
  let kept = 0;
  let at = 2;
  for (;;) {
    if (at + 4 > head.length || head[at] !== 0xff) return null;
    const marker = head[at + 1] as number;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xda) break;
    if (marker === 0xd8 || marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = ((head[at + 2] as number) << 8) | (head[at + 3] as number);
    if (length < 2) return null;
    if (marker === 0xe1 && isExif(head, at + 4)) {
      parts.push(file.slice(start + kept, start + at));
      kept = at + 2 + length;
    }
    at += 2 + length;
  }
  parts.push(file.slice(start + kept, end));
  return new Blob(parts, { type: "image/jpeg" });
}

/** Draws a centre-cropped, correctly oriented `size`×`size` thumbnail. */
export async function createThumbnail(
  file: Blob,
  preview: PreviewRef,
  orientation: number,
  size: number,
): Promise<HTMLCanvasElement | null> {
  const jpeg = await previewWithoutExif(file, preview);
  if (!jpeg) return null;
  const options: ImageBitmapOptions =
    preview.height > preview.width
      ? { resizeWidth: size, resizeQuality: "medium" }
      : { resizeHeight: size, resizeQuality: "medium" };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(jpeg, options);
  } catch {
    bitmap = await createImageBitmap(jpeg);
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const [a, b, c, d, e, f] = ORIENTATIONS[orientation] ?? [1, 0, 0, 1, 0, 0];
    context.setTransform(a, b, c, d, e * size, f * size);
    context.imageSmoothingQuality = "high";
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
    return canvas;
  } finally {
    bitmap.close();
  }
}

/**
 * Portrait, player side (D8–D10, from spike 1.5): check the chosen file, resize it to at most 1024 px on the
 * long side and encode WebP within 512 KB, in the browser. The result is the `image` payload of
 * `QUERIES.SUBMIT` / `QUERIES.UPLOAD_PORTRAIT`; the GM checks it again (gm/portrait.mjs).
 */

import { LIMITS, makeError } from "../contracts.mjs";
import { readSettings } from "../settings/settings.mjs";

const ACCEPTED = ["image/png", "image/jpeg", "image/webp"];
const QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];

/** Thrown with a contract error: `err.error` is the makeError() object. */
export class PortraitError extends Error {
  constructor(code, detail) {
    super(`${code}${detail ? `: ${JSON.stringify(detail)}` : ""}`);
    this.error = makeError(code, detail);
  }
}

/**
 * Check, resize and encode an image file.
 * @param {Blob} file
 * @param {{ maxSourceBytes?: number }} [options]   Default: the GM's upload size setting (PLAN 2.10).
 * @returns {Promise<{ mime: "image/webp", data: string, width: number, height: number }>}
 */
export async function preparePortrait(file, { maxSourceBytes = readSettings().portraits.maxSourceBytes } = {}) {
  if ( !readSettings().portraits.enabled ) throw new PortraitError("UPLOADS_DISABLED");
  if ( !ACCEPTED.includes(file?.type) ) throw new PortraitError("WRONG_IMAGE_TYPE", { type: file?.type ?? null });
  if ( file.size > maxSourceBytes ) throw new PortraitError("IMAGE_TOO_LARGE", { bytes: file.size, max: maxSourceBytes });
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new PortraitError("UNREADABLE_IMAGE");
  }
  const scale = Math.min(1, LIMITS.portraitMaxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  let blob;
  for ( const quality of QUALITIES ) {
    blob = await canvas.convertToBlob({ type: "image/webp", quality });
    if ( blob.type !== "image/webp" ) throw new PortraitError("WRONG_IMAGE_TYPE", { encoded: blob.type });
    if ( blob.size <= LIMITS.portraitMaxBytes ) break;
  }
  if ( blob.size > LIMITS.portraitMaxBytes ) throw new PortraitError("IMAGE_TOO_LARGE", { bytes: blob.size, max: LIMITS.portraitMaxBytes });
  return { mime: "image/webp", data: await toBase64(blob), width, height };
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for ( let i = 0; i < bytes.length; i += 0x8000 ) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

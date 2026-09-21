/**
 * Portrait, GM side (D8–D10, D22; from spike 1.5): check the image again (never trust the player's
 * claims), save it with the document-scoped upload and point the actor's portrait, token and ring at it.
 */

import { MODULE_ID, LIMITS, makeError } from "../contracts.mjs";

const color = v => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : null);

/**
 * Check an image payload for real: WebP signature, size, and decoded dimensions matching its claims.
 * @returns {Promise<{ blob: Blob, bytes: number }|{ error: object }>}
 */
export async function inspectImage(image) {
  const bad = detail => ({ error: makeError("BAD_IMAGE", detail) });
  if ( image?.mime !== "image/webp" || typeof image.data !== "string" ) return bad("type");
  let bytes;
  try {
    bytes = Uint8Array.from(atob(image.data), c => c.charCodeAt(0));
  } catch {
    return bad("base64");
  }
  if ( bytes.length > LIMITS.portraitMaxBytes ) return { error: makeError("IMAGE_TOO_LARGE", { bytes: bytes.length }) };
  const ascii = (a, b) => String.fromCharCode(...bytes.subarray(a, b));
  if ( ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WEBP" ) return bad("signature");
  const blob = new Blob([bytes], { type: "image/webp" });
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return { error: makeError("UNREADABLE_IMAGE") };
  }
  const { width, height } = bitmap;
  bitmap.close();
  if ( Math.max(width, height) > LIMITS.portraitMaxSide || width !== image.width || height !== image.height ) {
    return bad({ width, height, claimed: [image.width, image.height] });
  }
  return { blob, bytes: bytes.length };
}

/**
 * Save a portrait for an actor (D22: file `<actorId>.webp` uploaded with `{ uuid: actor.uuid }`, stored as
 * `worlds/<w>/assets/actors/<actorId>-<random>.webp` and removed by the server with the actor) and set img,
 * token texture and ring. Callers check permissions and the uploads setting first.
 * @returns {Promise<{ ok: true, path: string }|{ ok: false, error: object }>}
 */
export async function savePortrait(actor, image, ring = {}, user = game.user, { ringDefaults = {} } = {}) {
  const checked = await inspectImage(image);
  if ( checked.error ) return { ok: false, error: checked.error };
  const file = new File([checked.blob], `${actor.id}.webp`, { type: "image/webp" });
  const FP = foundry.applications.apps.FilePicker.implementation;
  let res;
  try {
    res = await FP.upload("data", "", file, { uuid: actor.uuid }, { notify: false });
  } catch ( err ) {
    return { ok: false, error: makeError("UPLOAD_FAILED", { message: err.message }) };
  }
  if ( !res?.path ) return { ok: false, error: makeError("UPLOAD_FAILED") };
  // The token shows a round cut-out of the same picture. Token art is a cut-out, not a full-bleed photo:
  // the dynamic ring draws it inside its circle, and a character sheet showing token art draws it uncropped
  // and without its frame, so a square picture would spill over everything around it.
  let token = res.path;
  const cutout = await roundCutout(checked.blob);
  if ( cutout ) {
    try {
      const file = new File([cutout], `${actor.id}-token.webp`, { type: "image/webp" });
      const res2 = await FP.upload("data", "", file, { uuid: actor.uuid }, { notify: false });
      if ( res2?.path ) token = res2.path;
    } catch ( err ) {
      console.warn(`${MODULE_ID} | the token cut-out couldn't be saved`, err);
    }
  }
  await actor.update({
    img: res.path,
    "prototypeToken.texture.src": token,
    "prototypeToken.ring": {
      enabled: true,
      // The player's choice, else the GM's default (setting), else the player's user color.
      colors: { ring: color(ring?.ring) ?? color(ringDefaults.ring) ?? user.color?.css ?? null,
        background: color(ring?.background) ?? color(ringDefaults.background) },
      effects: Number.isInteger(ring?.effects) ? ring.effects : 1,
      subject: { texture: token, scale: 1 }
    }
  });
  return { ok: true, path: res.path, token };
}

/**
 * A round cut-out of the picture: the middle square, masked to a circle, transparent outside it. Returns null
 * if this browser can't do it — the picture itself is then used, as before.
 * @param {Blob} blob   The checked WebP.
 * @returns {Promise<Blob|null>}
 */
export async function roundCutout(blob) {
  if ( !globalThis.OffscreenCanvas || !globalThis.createImageBitmap ) return null;
  try {
    const bitmap = await createImageBitmap(blob);
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(side, side);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.beginPath();
    ctx.arc(side / 2, side / 2, side / 2, 0, Math.PI * 2);
    ctx.clip();
    // The middle of the picture, so a portrait keeps its face rather than its feet.
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, side, side);
    bitmap.close();
    const out = await canvas.convertToBlob({ type: "image/webp", quality: 0.9 });
    return (out.type === "image/webp") && (out.size <= LIMITS.portraitMaxBytes) ? out : null;
  } catch ( err ) {
    console.warn(`${MODULE_ID} | the token cut-out couldn't be made`, err);
    return null;
  }
}

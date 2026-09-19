/**
 * Portrait, GM side (D8–D10, D22; from spike 1.5): check the image again (never trust the player's
 * claims), save it with the document-scoped upload and point the actor's portrait, token and ring at it.
 */

import { LIMITS, makeError } from "../contracts.mjs";

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
 * token texture and ring. Callers check permissions first.
 * @returns {Promise<{ ok: true, path: string }|{ ok: false, error: object }>}
 */
export async function savePortrait(actor, image, ring = {}, user = game.user) {
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
  await actor.update({
    img: res.path,
    "prototypeToken.texture.src": res.path,
    "prototypeToken.ring": {
      enabled: true,
      colors: { ring: color(ring?.ring) ?? user.color?.css ?? null, background: color(ring?.background) },
      effects: Number.isInteger(ring?.effects) ? ring.effects : 1,
      subject: { texture: res.path, scale: 1 }
    }
  });
  return { ok: true, path: res.path };
}

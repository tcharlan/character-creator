/*
 * SPIKE 1.5 — throwaway. Not part of the module (registered only by the Quench suites).
 *
 * Question: the portrait relay (D8–D10). The player's browser checks, resizes (≤ 1024 px) and encodes
 * WebP (≤ 512 KB), then sends base64 in a query; the active GM validates it, saves it with
 * FilePicker.upload (players lack FILES_UPLOAD) and sets the actor's portrait, token image and ring.
 *
 * Upload mode: `body.uuid = actor.uuid` with a file named `<actorId>.webp`. The server stores it as
 * `worlds/<world>/assets/actors/<actorId>-<random>.webp` and deletes files starting with the actor id
 * when the actor is deleted (verified here).
 */

const MODULE_ID = "character-creator";
export const UPLOAD = `${MODULE_ID}.spikeUploadPortrait`;
export const MAKE_ACTOR = `${MODULE_ID}.spikeMakeActor`;

export const LIMITS = { maxSourceBytes: 10 * 1024 * 1024, maxSide: 1024, maxBytes: 512 * 1024 };
const ACCEPTED = ["image/png", "image/jpeg", "image/webp"];

export class PortraitError extends Error {
  constructor(code, detail) {
    super(`${code}${detail ? `: ${JSON.stringify(detail)}` : ""}`);
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------- */
/*  Player side                                 */
/* -------------------------------------------- */

/**
 * Check, resize and encode an image file for upload.
 * @param {Blob} file
 * @returns {Promise<{mime, data, width, height, bytes, quality, source: {width, height, bytes}}>}
 */
export async function preparePortrait(file, limits = LIMITS) {
  if ( !ACCEPTED.includes(file.type) ) throw new PortraitError("WRONG_TYPE", file.type);
  if ( file.size > limits.maxSourceBytes ) throw new PortraitError("TOO_LARGE", { bytes: file.size });
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new PortraitError("UNREADABLE");
  }
  const scale = Math.min(1, limits.maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  const source = { width: bitmap.width, height: bitmap.height, bytes: file.size };
  bitmap.close();

  let blob;
  let quality;
  for ( quality of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3] ) {
    blob = await canvas.convertToBlob({ type: "image/webp", quality });
    if ( blob.type !== "image/webp" ) throw new PortraitError("ENCODE_UNSUPPORTED", blob.type);
    if ( blob.size <= limits.maxBytes ) break;
  }
  if ( blob.size > limits.maxBytes ) throw new PortraitError("TOO_LARGE_AFTER_RESIZE", { bytes: blob.size });
  return { mime: "image/webp", data: await toBase64(blob), width, height, bytes: blob.size, quality, source };
}

/** Send a prepared portrait to the active GM. Refuses when no GM is online (A5). */
export async function sendPortrait(actorUuid, image, ring) {
  const gm = game.users.activeGM;
  if ( !gm ) throw new PortraitError("GM_OFFLINE");
  return gm.query(UPLOAD, { actorUuid, image, ring }, { timeout: 60_000 });
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for ( let i = 0; i < bytes.length; i += 0x8000 ) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A test image: gradient + shapes (compresses well) or random noise (doesn't). */
export async function makeTestImage(width, height, { noise = false, type = "image/png" } = {}) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if ( noise ) {
    const img = ctx.createImageData(width, height);
    const buf = new Uint32Array(img.data.buffer);
    for ( let i = 0; i < buf.length; i++ ) buf[i] = (Math.random() * 0xFFFFFF) | 0xFF000000;
    ctx.putImageData(img, 0, 0);
  } else {
    const g = ctx.createLinearGradient(0, 0, width, height);
    g.addColorStop(0, "#1b2a49");
    g.addColorStop(1, "#c9a227");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#e8e2d0";
    ctx.beginPath();
    ctx.arc(width / 2, height / 2.4, Math.min(width, height) / 4, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas.convertToBlob({ type });
}

/* -------------------------------------------- */
/*  GM side                                     */
/* -------------------------------------------- */

export function registerPortraitQueries() {
  CONFIG.queries[UPLOAD] = handleUpload;
  CONFIG.queries[MAKE_ACTOR] = handleMakeActor;
}

const isActiveGM = () => game.user.isGM && game.users.activeGM?.isSelf;

/**
 * Validate and save a portrait; set img, token texture and ring.
 * @param {{ actorUuid: string, image: {mime, data, width, height}, ring?: {ring, background, effects} }} data
 * @param {{ user: User }} context
 */
async function handleUpload(data, { user }) {
  if ( !isActiveGM() ) throw new Error("Only the active GM handles uploads");
  const { actorUuid, image, ring = {} } = data ?? {};
  const actor = typeof actorUuid === "string" ? await fromUuid(actorUuid) : null;
  if ( !(actor instanceof Actor) ) return { ok: false, code: "NO_ACTOR" };
  if ( !actor.testUserPermission(user, "OWNER") ) return { ok: false, code: "NOT_OWNER" };
  return savePortrait(actor, image, ring, user);
}

/**
 * GM side: check an image (type, size, signature, real dimensions), save it with the document-scoped
 * upload (D22) and point img, token texture and ring at it. Callers check permissions first.
 */
export async function savePortrait(actor, image, ring = {}, user = game.user) {
  const started = performance.now();

  // Never trust the player's claims: check type, size, signature and real dimensions.
  if ( image?.mime !== "image/webp" || typeof image.data !== "string" ) return { ok: false, code: "BAD_IMAGE", detail: "type" };
  let bytes;
  try {
    bytes = Uint8Array.from(atob(image.data), c => c.charCodeAt(0));
  } catch {
    return { ok: false, code: "BAD_IMAGE", detail: "base64" };
  }
  if ( bytes.length > LIMITS.maxBytes ) return { ok: false, code: "BAD_IMAGE", detail: `bytes ${bytes.length}` };
  const ascii = (a, b) => String.fromCharCode(...bytes.subarray(a, b));
  if ( ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WEBP" ) return { ok: false, code: "BAD_IMAGE", detail: "signature" };
  const blob = new Blob([bytes], { type: "image/webp" });
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return { ok: false, code: "BAD_IMAGE", detail: "decode" };
  }
  const { width, height } = bitmap;
  bitmap.close();
  if ( Math.max(width, height) > LIMITS.maxSide || width !== image.width || height !== image.height ) {
    return { ok: false, code: "BAD_IMAGE", detail: { width, height, claimed: [image.width, image.height] } };
  }

  const file = new File([blob], `${actor.id}.webp`, { type: "image/webp" });
  const FP = foundry.applications.apps.FilePicker.implementation;
  const res = await FP.upload("data", "", file, { uuid: actor.uuid }, { notify: false });
  if ( !res?.path ) return { ok: false, code: "UPLOAD_FAILED" };
  const uploadMs = Math.round(performance.now() - started);

  const color = v => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : null);
  await actor.update({
    img: res.path,
    "prototypeToken.texture.src": res.path,
    "prototypeToken.ring": {
      enabled: true,
      colors: { ring: color(ring.ring) ?? user.color?.css ?? null, background: color(ring.background) },
      effects: Number.isInteger(ring.effects) ? ring.effects : 1,
      subject: { texture: res.path, scale: 1 }
    }
  });
  return { ok: true, path: res.path, diagnostics: { uploadMs, totalMs: Math.round(performance.now() - started), bytes: bytes.length } };
}

/** Test helper: create a spike-flagged actor, owned by the sender or by nobody. */
async function handleMakeActor({ owned = true } = {}, { user }) {
  if ( !isActiveGM() ) throw new Error("Only the active GM creates test actors");
  const L = CONST.DOCUMENT_OWNERSHIP_LEVELS;
  const actor = await Actor.implementation.create({
    name: owned ? "Spike 1.5 owned" : "Spike 1.5 not owned", type: "character",
    ownership: owned ? { default: L.NONE, [user.id]: L.OWNER } : { default: L.NONE },
    flags: { [MODULE_ID]: { spike14: true } }
  });
  return { uuid: actor.uuid };
}

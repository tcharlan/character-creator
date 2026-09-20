/**
 * The Portrait step (PLAN 3.8, D8–D10): choose a picture, see it as it will look on the token ring, or skip it.
 * The picture is resized in the player's browser (`portrait/prepare.mjs`) and travels with the submission; the
 * GM's browser is what saves it (D13/D22).
 */

const HEX = /^#[0-9a-f]{6}$/i;

/** A prepared image as something an <img> can show. */
export const previewUrl = image => (image?.data ? `data:${image.mime};base64,${image.data}` : null);

/** Put a prepared image on the draft. */
export function setImage(draft, image) {
  draft.portrait = { ...draft.portrait, status: "ready", pendingImage: image };
  return draft;
}

/** Take the picture off again (back to "none"). */
export function clearImage(draft) {
  draft.portrait = { ...draft.portrait, status: "none", pendingImage: null };
  return draft;
}

/** Carry on without a portrait; one can be uploaded later from the character sheet (A5). */
export function skipPortrait(draft) {
  draft.portrait = { ...draft.portrait, status: "skipped", pendingImage: null };
  return draft;
}

/** Set one of the ring colours; anything that isn't a #rrggbb colour clears it (the player's own colour is used). */
export function setRingColor(draft, which, value) {
  if ( !["ring", "background"].includes(which) ) return draft;
  draft.portrait = { ...draft.portrait, ring: { ...draft.portrait.ring, [which]: HEX.test(value ?? "") ? value.toLowerCase() : null } };
  return draft;
}

/** Set the ring effects (a dnd5e/Foundry bitmask; kept as-is, the sheet can change it later). */
export function setRingEffects(draft, effects) {
  const value = Number(effects);
  if ( !Number.isInteger(value) || (value < 0) ) return draft;
  draft.portrait = { ...draft.portrait, ring: { ...draft.portrait.ring, effects: value } };
  return draft;
}

/**
 * The screen's model.
 * @param {object} draft
 * @param {object} options
 * @param {boolean} [options.enabled]        Whether the GM allows uploads (PLAN 2.10).
 * @param {number} [options.maxSourceBytes]  The largest file the GM allows.
 * @param {{ ring: string|null, background: string|null }} [options.defaults]  The GM's default ring colours.
 * @param {string} [options.userColor]       The player's own colour, used when no ring colour is set.
 */
export function portraitModel(draft, { enabled = true, maxSourceBytes = 0, defaults = {}, userColor = null } = {}) {
  const portrait = draft?.portrait ?? { status: "none", ring: {}, pendingImage: null };
  const ring = portrait.ring ?? {};
  return {
    enabled,
    status: portrait.status,
    chosen: portrait.status === "ready",
    skipped: portrait.status === "skipped",
    preview: previewUrl(portrait.pendingImage),
    size: portrait.pendingImage ? Math.round((portrait.pendingImage.data.length * 3) / 4 / 1024) : null,
    dimensions: portrait.pendingImage ? `${portrait.pendingImage.width} × ${portrait.pendingImage.height}` : null,
    maxMB: maxSourceBytes ? Math.round(maxSourceBytes / (1024 * 1024)) : null,
    ring: {
      ring: ring.ring ?? null,
      background: ring.background ?? null,
      effects: ring.effects ?? 1,
      // What the preview paints with: the player's choice, else the GM's default, else the player's own colour.
      ringShown: ring.ring ?? defaults.ring ?? userColor ?? "#d4ad57",
      backgroundShown: ring.background ?? defaults.background ?? "#1a1e24"
    }
  };
}

/**
 * The "Upload portrait" dialog for a character that already exists (PLAN 4.3, A5). Pure: what the dialog shows
 * and what stops it. The picture itself is checked and resized by `prepare.mjs` and saved by the GM
 * (`gm/portrait.mjs`) — this only decides what the player sees.
 */

/** A prepared image as a data URL for the preview. */
export const imageUrl = image => (image?.data ? `data:${image.mime};base64,${image.data}` : null);

/** Why the dialog can't save, in the order the player should hear about it. */
export function blockedBy({ isOwner = true, uploads = true, gmOnline = true } = {}) {
  if ( !isOwner ) return "NOT_OWNER";
  if ( !uploads ) return "UPLOADS_DISABLED";
  if ( !gmOnline ) return "GM_OFFLINE";
  return null;
}

/** The dialog's own state: nothing chosen yet, the actor's current ring colours. */
export function dialogState(ring = {}) {
  return {
    image: null,
    ring: { ring: ring.ring ?? null, background: ring.background ?? null,
      effects: Number.isInteger(ring.effects) ? ring.effects : 1 },
    error: null,
    saving: false
  };
}

/** Put a prepared picture in the dialog (or take it out again). */
export function setDialogImage(state, image) {
  state.image = image ?? null;
  state.error = null;
  return state;
}

/** One of the ring colours ("" clears it, back to the default). */
export function setDialogRing(state, key, value) {
  if ( !["ring", "background"].includes(key) ) return state;
  state.ring = { ...state.ring, [key]: value || null };
  return state;
}

/**
 * The screen.
 * @param {object} state                 dialogState()
 * @param {object} options
 * @param {string} options.name          The character's name.
 * @param {string} options.current       The portrait it has now.
 * @param {boolean} [options.isOwner]
 * @param {boolean} [options.uploads]    The GM allows uploads (PLAN 2.10).
 * @param {boolean} [options.gmOnline]   A GM is online (A5: this one can't wait in a queue).
 * @param {{ ring, background }} [options.defaults]   The GM's default ring colours.
 * @param {string|null} [options.userColor]           The player's own colour, the last fallback.
 * @param {number|null} [options.maxSourceBytes]
 */
export function dialogModel(state, { name, current, isOwner = true, uploads = true, gmOnline = true,
  defaults = {}, userColor = null, maxSourceBytes = null } = {}) {
  const blocked = blockedBy({ isOwner, uploads, gmOnline });
  const chosen = !!state.image;
  return {
    name,
    current,
    preview: imageUrl(state.image) ?? current,
    chosen,
    size: chosen ? Math.round((state.image.data.length * 3) / 4 / 1024) : null,
    dimensions: chosen ? `${state.image.width} × ${state.image.height}` : null,
    maxMB: maxSourceBytes ? Math.round(maxSourceBytes / (1024 * 1024)) : null,
    ring: {
      ring: state.ring.ring,
      background: state.ring.background,
      // What the preview paints with: the player's choice, else the GM's default, else the player's own colour.
      ringPaint: state.ring.ring ?? defaults.ring ?? userColor ?? null,
      backgroundPaint: state.ring.background ?? defaults.background ?? null
    },
    blocked,
    blockedKey: blocked ? `CHARCREATOR.Error.${blocked}` : null,
    canChoose: !blocked && !state.saving,
    canSave: chosen && !blocked && !state.saving,
    saving: state.saving,
    error: state.error
  };
}

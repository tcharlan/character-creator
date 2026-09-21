/**
 * Fullscreen or a window (D28). The creator opens fullscreen — covering Foundry's interface, like a title screen —
 * and a header button switches to an ordinary draggable, resizable window and back. Each player's choice, and
 * where they left the window, is remembered on their own computer (a client setting).
 *
 * Pure apart from `readDisplay` / `saveDisplay`, which take the settings accessor so the rules here run under
 * `npm test`.
 */

export const DISPLAY_MODES = Object.freeze(["fullscreen", "window"]);

/** The window the creator opens as when there's nothing remembered (the size it has always had). */
export const WINDOW_DEFAULT = Object.freeze({ width: 1280, height: 760 });

/** The smallest window that still shows the three columns. */
export const WINDOW_MIN = Object.freeze({ width: 900, height: 560 });

const finite = v => (typeof v === "number") && Number.isFinite(v);

/** A stored display value made safe: an unknown mode is fullscreen; a window without numbers is forgotten. */
export function normalizeDisplay(value) {
  const mode = DISPLAY_MODES.includes(value?.mode) ? value.mode : "fullscreen";
  const w = value?.window;
  const window = (w && ["left", "top", "width", "height"].every(k => finite(w[k])))
    ? { left: Math.round(w.left), top: Math.round(w.top), width: Math.round(w.width), height: Math.round(w.height) }
    : null;
  return { mode, window };
}

/** Fullscreen: the whole viewport. */
export function fullscreenPosition(viewport) {
  return { left: 0, top: 0, width: Math.round(viewport.width), height: Math.round(viewport.height), scale: 1 };
}

/**
 * The window's position: the remembered one if there is one, kept on screen and no smaller than WINDOW_MIN
 * (nor larger than the viewport); otherwise the default size, centred.
 */
export function windowPosition(saved, viewport) {
  const vw = Math.max(1, Math.round(viewport.width));
  const vh = Math.max(1, Math.round(viewport.height));
  const size = saved ?? WINDOW_DEFAULT;
  const width = Math.min(vw, Math.max(Math.min(WINDOW_MIN.width, vw), Math.round(size.width)));
  const height = Math.min(vh, Math.max(Math.min(WINDOW_MIN.height, vh), Math.round(size.height)));
  const left = saved ? Math.min(Math.max(0, Math.round(saved.left)), vw - width) : Math.round((vw - width) / 2);
  const top = saved ? Math.min(Math.max(0, Math.round(saved.top)), vh - height) : Math.round((vh - height) / 2);
  return { left, top, width, height, scale: 1 };
}

/** The header button for a mode: what pressing it does next. */
export function displayButton(mode) {
  return mode === "fullscreen"
    ? { icon: "fa-solid fa-down-left-and-up-right-to-center", label: "CHARCREATOR.Display.ToWindow" }
    : { icon: "fa-solid fa-up-right-and-down-left-from-center", label: "CHARCREATOR.Display.ToFullscreen" };
}

/** Read this player's display choice. `get` is `key => game.settings.get(MODULE_ID, key)`. */
export function readDisplay(get, key) {
  try {
    return normalizeDisplay(get(key));
  } catch {
    return normalizeDisplay(null);
  }
}

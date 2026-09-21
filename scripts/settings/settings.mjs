/**
 * Register the GM settings (PLAN 2.10) and read them normalised. Scalar settings appear in Foundry's own
 * settings window now; restrictions, ability methods and ring colours are objects edited by the module's
 * settings UI in Phase 4 (hidden from the core window until then).
 */

import { MODULE_ID } from "../contracts.mjs";
import { SETTINGS, DEFAULTS, UPLOAD_MB_RANGE, normalizeSettings } from "./normalize.mjs";
import { registerRestrictionsApp } from "./restrictions-app.mjs";

export { SETTINGS };

const label = key => `CHARCREATOR.Settings.${key}.Name`;
const hint = key => `CHARCREATOR.Settings.${key}.Hint`;

export function registerSettings() {
  const world = (key, data) => game.settings.register(MODULE_ID, key, {
    name: label(key), hint: hint(key), scope: "world", default: DEFAULTS[key], ...data
  });
  world(SETTINGS.RESTRICTIONS, { type: Object, config: false, default: { packs: null, categories: {} } });
  world(SETTINGS.ABILITY_METHODS, { type: Array, config: false, default: [...DEFAULTS[SETTINGS.ABILITY_METHODS]] });
  world(SETTINGS.CHARACTER_LIMIT, { type: Number, config: true, range: { min: 0, max: 20, step: 1 } });
  world(SETTINGS.FOLDER, { type: String, config: true });
  world(SETTINGS.SHOW_ON_LOGIN, { type: Boolean, config: true });
  world(SETTINGS.UPLOADS, { type: Boolean, config: true });
  world(SETTINGS.MAX_UPLOAD_MB, { type: Number, config: true, range: { ...UPLOAD_MB_RANGE, step: 1 } });
  world(SETTINGS.RING_COLORS, { type: Object, config: false, default: { ring: null, background: null } });
  // The objects above are edited on their own screen (PLAN 4.1), which the settings window links to.
  registerRestrictionsApp();
}

/** The module's settings, normalised (see normalize.mjs). */
export function readSettings() {
  return normalizeSettings(key => game.settings.get(MODULE_ID, key));
}

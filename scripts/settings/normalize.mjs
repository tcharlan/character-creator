/**
 * GM settings (PLAN 2.10; DESIGN.md → Settings): keys, defaults, and a normaliser that turns whatever is stored
 * into safe values — a corrupt or hand-edited value falls back to its default rather than breaking the module.
 * Pure; `settings.mjs` registers them with Foundry.
 */

import { ABILITY_METHODS, LIMITS } from "../contracts.mjs";
import { CATEGORIES, NO_RESTRICTIONS, normalizeUuid } from "../catalog/filters.mjs";

export const SETTINGS = Object.freeze({
  RESTRICTIONS: "restrictions",          // { packs: string[]|null, categories: { [category]: uuid[]|null } }
  ABILITY_METHODS: "abilityMethods",     // subset of ABILITY_METHODS
  CHARACTER_LIMIT: "characterLimit",     // 0 = no limit
  FOLDER: "folderName",                  // "" = no folder
  SHOW_ON_LOGIN: "showOnLogin",
  UPLOADS: "allowPortraitUploads",
  MAX_UPLOAD_MB: "maxUploadMB",
  RING_COLORS: "ringColors",             // { ring: "#rrggbb"|null, background: "#rrggbb"|null }; null = player's color
  OPTION_ART: "optionArt"                // { [option uuid]: image path }; D24, the GM's own picture per option
});

export const DEFAULTS = Object.freeze({
  [SETTINGS.RESTRICTIONS]: NO_RESTRICTIONS,
  [SETTINGS.ABILITY_METHODS]: [...ABILITY_METHODS],
  [SETTINGS.CHARACTER_LIMIT]: 1,
  [SETTINGS.FOLDER]: "Player Characters",
  [SETTINGS.SHOW_ON_LOGIN]: true,
  [SETTINGS.UPLOADS]: true,
  [SETTINGS.MAX_UPLOAD_MB]: LIMITS.portraitSourceMaxBytes / (1024 * 1024),
  [SETTINGS.RING_COLORS]: Object.freeze({ ring: null, background: null }),
  [SETTINGS.OPTION_ART]: Object.freeze({})
});

/** As many pictures as a GM could plausibly assign, and no path longer than this. */
export const ART_LIMITS = Object.freeze({ entries: 500, pathLength: 512 });

/** Bounds of the upload size setting, in MB. */
export const UPLOAD_MB_RANGE = Object.freeze({ min: 1, max: 50 });

const isStringList = v => Array.isArray(v) && v.every(x => typeof x === "string");
const color = v => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null);

/** Restrictions: `packs` a list or null; each known category a list or null; unknown categories dropped. */
export function normalizeRestrictions(v) {
  if ( !v || typeof v !== "object" ) return { packs: null, categories: {} };
  const categories = {};
  for ( const c of CATEGORIES ) {
    const list = v.categories?.[c];
    if ( isStringList(list) ) categories[c] = [...new Set(list)];
  }
  return { packs: isStringList(v.packs) ? [...new Set(v.packs)] : null, categories };
}

/**
 * The GM's own picture per option (D24): a map of option UUID to an image path in this world. Anything that
 * isn't a plain path is dropped rather than shown to a player.
 */
export function normalizeOptionArt(v) {
  if ( !v || (typeof v !== "object") ) return {};
  const out = {};
  for ( const [uuid, path] of Object.entries(v).slice(0, ART_LIMITS.entries) ) {
    if ( (typeof path !== "string") || !path.trim() || (path.length > ART_LIMITS.pathLength) ) continue;
    // A path inside this world only: no data:, file: or http(s) URLs, so nothing is ever fetched from elsewhere.
    if ( /^[a-z][a-z0-9+.-]*:/i.test(path.trim()) ) continue;
    out[normalizeUuid(uuid)] = path.trim();
  }
  return out;
}

/**
 * Normalised settings the module reads.
 * @param {(key: string) => any} get   Stored value by key (undefined when unset or unreadable).
 * @returns {{ restrictions, abilityMethods: string[], characterLimit: number|null, folderName: string,
 *   showOnLogin: boolean, portraits: { enabled: boolean, maxSourceBytes: number }, ringColors: { ring, background } }}
 */
export function normalizeSettings(get) {
  const read = key => {
    try {
      const v = get(key);
      return v === undefined ? DEFAULTS[key] : v;
    } catch {
      return DEFAULTS[key];
    }
  };
  const methods = read(SETTINGS.ABILITY_METHODS);
  const allowed = Array.isArray(methods) ? ABILITY_METHODS.filter(m => methods.includes(m)) : [];
  const limit = Number(read(SETTINGS.CHARACTER_LIMIT));
  const mb = Number(read(SETTINGS.MAX_UPLOAD_MB));
  const folder = read(SETTINGS.FOLDER);
  const ring = read(SETTINGS.RING_COLORS);
  const bool = (key, fallback) => (typeof read(key) === "boolean" ? read(key) : fallback);
  return {
    restrictions: normalizeRestrictions(read(SETTINGS.RESTRICTIONS)),
    // An empty or unreadable list would leave no way to set scores: fall back to all methods.
    abilityMethods: allowed.length ? allowed : [...ABILITY_METHODS],
    characterLimit: Number.isInteger(limit) && limit > 0 ? limit : (limit === 0 ? null : DEFAULTS[SETTINGS.CHARACTER_LIMIT]),
    folderName: typeof folder === "string" ? folder.trim().slice(0, 100) : DEFAULTS[SETTINGS.FOLDER],
    showOnLogin: bool(SETTINGS.SHOW_ON_LOGIN, true),
    portraits: {
      enabled: bool(SETTINGS.UPLOADS, true),
      maxSourceBytes: Math.round((Number.isFinite(mb) ? Math.min(UPLOAD_MB_RANGE.max, Math.max(UPLOAD_MB_RANGE.min, mb))
        : DEFAULTS[SETTINGS.MAX_UPLOAD_MB]) * 1024 * 1024)
    },
    ringColors: { ring: color(ring?.ring), background: color(ring?.background) },
    optionArt: normalizeOptionArt(read(SETTINGS.OPTION_ART))
  };
}

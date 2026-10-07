/**
 * GM settings (PLAN 2.10; DESIGN.md → Settings): keys, defaults, and a normaliser that turns whatever is stored
 * into safe values — a corrupt or hand-edited value falls back to its default rather than breaking the module.
 * Pure; `settings.mjs` registers them with Foundry.
 */

import { ABILITY_METHODS, LIMITS, MAX_ATTEMPTS, MAX_LEVEL, RANDOM_PARTS, STEPS } from "../contracts.mjs";
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
  OPTION_ART: "optionArt",               // { [option uuid]: image path }; D24, the GM's own picture per option
  STEP_ART: "stepArt",
  HARDCORE: "hardcore",                  // { offered, free, attempts, multiclassChoices, feats, featChoices, subclassChoices }; D31, D35, D36, D39
  STARTING_LEVEL: "startingLevel",       // 1–20; D32
  HIT_POINTS: "hitPointMethod",          // "average" | "rolled"; D33
  GOLD_PER_LEVEL: "goldPerLevel",        // gp for each level above the first; D34
  MULTICLASS: "multiclass",              // D35
  MULTICLASS_PREREQUISITES: "multiclassPrerequisites",   // D35: respected (true) or ignored
  FIRST_CLASS_LEVELS: "multiclassFirstLevels",           // D35: the fewest levels the first class keeps
                   // { [wizard step]: image path }; D28, the GM's own background per step
  DISPLAY: "wizardDisplay"               // client: { mode: "fullscreen"|"window", window: position|null }; D28
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
  [SETTINGS.OPTION_ART]: Object.freeze({}),
  [SETTINGS.STEP_ART]: Object.freeze({}),
  [SETTINGS.HARDCORE]: Object.freeze({ offered: true, free: Object.freeze([]) }),
  [SETTINGS.STARTING_LEVEL]: 1,
  [SETTINGS.HIT_POINTS]: "average",
  [SETTINGS.GOLD_PER_LEVEL]: 0,
  [SETTINGS.MULTICLASS]: false,
  [SETTINGS.MULTICLASS_PREREQUISITES]: true,
  [SETTINGS.FIRST_CLASS_LEVELS]: 1,
  [SETTINGS.DISPLAY]: Object.freeze({ mode: "fullscreen", window: null })
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
    const clean = artPath(path);
    if ( clean ) out[normalizeUuid(uuid)] = clean;
  }
  return out;
}

/**
 * An image path the GM chose, or null: a path inside this world only — no data:, file: or http(s) URLs, so
 * nothing is ever fetched from elsewhere.
 */
export function artPath(path) {
  if ( (typeof path !== "string") || !path.trim() || (path.length > ART_LIMITS.pathLength) ) return null;
  if ( /^[a-z][a-z0-9+.-]*:/i.test(path.trim()) ) return null;
  return path.trim();
}

/** How hardcore mode handles the feat slots above level 1 (D36). */
export const HARDCORE_FEATS = Object.freeze(["shortlist", "rolled", "chosen"]);

/** Bounds of the hardcore shortlists: classes to multiclass into (D35) and feats at a feat slot (D36). */
export const SHORTLIST_RANGE = Object.freeze({ min: 1, max: 12 });

/**
 * Hardcore mode (D31): whether players may choose it, and which parts they may still choose themselves; above
 * level 1, how many classes the multiclass shortlist rolls (D35), and how feat slots go (D36). Anything unknown
 * is dropped, so a hand-edited setting can't hand players something that isn't a part.
 */
export function normalizeHardcore(v) {
  const free = Array.isArray(v?.free) ? RANDOM_PARTS.filter(part => v.free.includes(part)) : [];
  return { offered: typeof v?.offered === "boolean" ? v.offered : true, free, attempts: rollAttempts(v?.attempts),
    multiclassChoices: shortlistSize(v?.multiclassChoices, MULTICLASS_CHOICES), feats: HARDCORE_FEATS.includes(v?.feats) ? v.feats : "shortlist",
    featChoices: shortlistSize(v?.featChoices), subclassChoices: shortlistSize(v?.subclassChoices) };
}

/** How many classes the multiclass shortlist offers when the GM hasn't said (D35); feats and subclasses offer 3. */
export const MULTICLASS_CHOICES = 2;

/** A shortlist size: the default unless set to a whole number in range; 0 means every option (D35, D36, D39). */
export function shortlistSize(v, fallback = 3) {
  const n = Number(v);
  if ( !Number.isInteger(n) ) return fallback;
  if ( n === 0 ) return 0;
  return Math.min(SHORTLIST_RANGE.max, Math.max(SHORTLIST_RANGE.min, n));
}

/** Hit point methods past the first level (D33). */
export const HIT_POINT_METHODS = Object.freeze(["average", "rolled"]);

/** The most starting gold per level a GM can set (D34). */
export const MAX_GOLD_PER_LEVEL = 100000;

/**
 * Levels and classes (D32–D35): the starting level, how hit points go past the first, the gold for each level
 * above it, and multiclassing. A broken value falls back to a level-1, single-class game.
 */
export function normalizeLevels({ startingLevel, hitPointMethod, goldPerLevel, multiclass, prerequisites, firstClassLevels }) {
  const level = Number(startingLevel);
  const gold = Number(goldPerLevel);
  const first = Number(firstClassLevels);
  return {
    // The fewest levels a multiclassed character keeps in its first class (picked or rolled), 1 by default.
    firstClassLevels: Number.isInteger(first) ? Math.min(MAX_LEVEL, Math.max(1, first)) : 1,
    startingLevel: Number.isInteger(level) ? Math.min(MAX_LEVEL, Math.max(1, level)) : 1,
    hitPointMethod: HIT_POINT_METHODS.includes(hitPointMethod) ? hitPointMethod : "average",
    goldPerLevel: Number.isFinite(gold) ? Math.min(MAX_GOLD_PER_LEVEL, Math.max(0, Math.floor(gold))) : 0,
    multiclass: multiclass === true,
    prerequisites: prerequisites !== false
  };
}

/**
 * How many times a player may roll a character (D31): 1, the default, means the first roll is the character;
 * 0 means as often as they like. Anything else reads as the default, so a broken setting hands out no rolls.
 */
export function rollAttempts(v) {
  const n = Number(v);
  if ( !Number.isInteger(n) || (n < 0) ) return 1;
  return Math.min(n, MAX_ATTEMPTS);
}

/** The GM's own background per wizard step (D28): known steps only, paths as for option art. */
export function normalizeStepArt(v) {
  if ( !v || (typeof v !== "object") ) return {};
  const out = {};
  for ( const step of STEPS ) {
    const clean = artPath(v[step]);
    if ( clean ) out[step] = clean;
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
    optionArt: normalizeOptionArt(read(SETTINGS.OPTION_ART)),
    stepArt: normalizeStepArt(read(SETTINGS.STEP_ART)),
    hardcore: normalizeHardcore(read(SETTINGS.HARDCORE)),
    levels: normalizeLevels({ startingLevel: read(SETTINGS.STARTING_LEVEL), hitPointMethod: read(SETTINGS.HIT_POINTS),
      goldPerLevel: read(SETTINGS.GOLD_PER_LEVEL), multiclass: read(SETTINGS.MULTICLASS),
      prerequisites: read(SETTINGS.MULTICLASS_PREREQUISITES), firstClassLevels: read(SETTINGS.FIRST_CLASS_LEVELS) })
  };
}

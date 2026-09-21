/**
 * What the GM's "allowed content" screen shows and what a click there changes (PLAN 4.1). Pure: the app
 * (`restrictions-app.mjs`) brings the catalog and writes the settings; everything here is plain data.
 *
 * A category is either **all allowed** (`null`, the default) or an explicit list of UUIDs. Allowing every
 * entry again collapses back to `null`, so a world that never restricts anything stores nothing.
 */

import { CATEGORIES, normalizeUuid } from "../catalog/filters.mjs";
import { ABILITY_METHODS } from "../contracts.mjs";

/** The tabs, in order: one per category, then the packs and the ability-score methods. */
export const TABS = Object.freeze([...CATEGORIES, "packs", "abilities"]);

/** Categories a character can't be made without. */
export const REQUIRED = Object.freeze(["species", "background", "class"]);

const list = value => (Array.isArray(value) ? value.map(normalizeUuid) : null);

/**
 * The state the screen edits: the stored restrictions plus the allowed methods, as plain arrays.
 * @param {object} restrictions   From the setting (normalised).
 * @param {string[]} abilityMethods
 */
export function editorState(restrictions, abilityMethods) {
  const categories = {};
  for ( const category of CATEGORIES ) categories[category] = list(restrictions?.categories?.[category]);
  return { packs: list(restrictions?.packs), categories,
    abilityMethods: ABILITY_METHODS.filter(m => (abilityMethods ?? ABILITY_METHODS).includes(m)) };
}

/** What to store: categories left at "all" are dropped, so nothing is written for an unrestricted world. */
export function toStored(state) {
  const categories = {};
  for ( const [category, allowed] of Object.entries(state?.categories ?? {}) ) {
    if ( Array.isArray(allowed) ) categories[category] = [...new Set(allowed)];
  }
  return { packs: Array.isArray(state?.packs) ? [...new Set(state.packs)] : null, categories };
}

/** Is this entry allowed by the state? (`null` = the whole category is allowed.) */
export function isEntryAllowed(state, category, uuid) {
  const allowed = state?.categories?.[category];
  return !Array.isArray(allowed) || allowed.includes(normalizeUuid(uuid));
}

/**
 * Turn one entry on or off. The first entry turned off in an unrestricted category turns the rest into an
 * explicit list; turning the last missing one back on collapses to "all allowed" again.
 * @param {object} state
 * @param {string} category
 * @param {string} uuid
 * @param {string[]} everything   Every UUID the category offers, unrestricted.
 */
export function toggleEntry(state, category, uuid, everything) {
  const all = everything.map(normalizeUuid);
  const target = normalizeUuid(uuid);
  const current = state.categories[category];
  const allowed = Array.isArray(current) ? current.filter(u => all.includes(u)) : [...all];
  const next = allowed.includes(target) ? allowed.filter(u => u !== target) : [...allowed, target];
  state.categories[category] = (next.length === all.length) ? null : next;
  return state;
}

/** Allow the whole category again. */
export function allowAll(state, category) {
  state.categories[category] = null;
  return state;
}

/** Allow nothing in the category (players are then blocked — the screen says so). */
export function allowNone(state, category) {
  state.categories[category] = [];
  return state;
}

/** Allow only what matches the search (what the GM can see on screen). */
export function allowOnly(state, category, uuids) {
  state.categories[category] = uuids.map(normalizeUuid);
  return state;
}

/** Turn a pack on or off, the same way: `null` means every pack the world already enables. */
export function togglePack(state, collection, everything) {
  const all = [...everything];
  const packs = Array.isArray(state.packs) ? state.packs.filter(p => all.includes(p)) : [...all];
  const next = packs.includes(collection) ? packs.filter(p => p !== collection) : [...packs, collection];
  state.packs = (next.length === all.length) ? null : next;
  return state;
}

/** Turn an ability-score method on or off; the last one can't be turned off. */
export function toggleMethod(state, method) {
  if ( !ABILITY_METHODS.includes(method) ) return state;
  const has = state.abilityMethods.includes(method);
  if ( has && (state.abilityMethods.length === 1) ) return state;
  state.abilityMethods = ABILITY_METHODS.filter(m => (m === method ? !has : state.abilityMethods.includes(m)));
  return state;
}

/**
 * What the GM should know about the choices made here.
 * @param {object} state
 * @param {Record<string, object[]>} everything   Category → every entry, unrestricted.
 * @returns {{ key: string, category: string, level: "problem"|"note", count: number }[]}
 */
export function warnings(state, everything) {
  const out = [];
  for ( const category of CATEGORIES ) {
    const all = everything?.[category] ?? [];
    if ( !all.length ) continue;
    const allowed = all.filter(e => isEntryAllowed(state, category, e.uuid)).length;
    if ( !allowed ) {
      out.push({ key: REQUIRED.includes(category) ? "NoneRequired" : "NoneOptional", category, level: "problem",
        count: 0 });
    } else if ( (allowed === 1) && REQUIRED.includes(category) ) {
      out.push({ key: "OnlyOne", category, level: "note", count: 1 });
    }
  }
  if ( state.abilityMethods.length === 1 ) out.push({ key: "OneMethod", category: "abilities", level: "note", count: 1 });
  return out;
}

/**
 * The whole screen.
 * @param {object} options
 * @param {object} options.state                    editorState()
 * @param {Record<string, object[]>} options.everything   Category → every entry (uuid, name, img, pack).
 * @param {{ collection: string, label: string }[]} options.packs   Item packs the world enables.
 * @param {string} options.tab
 * @param {string} [options.search]
 */
export function restrictionsModel({ state, everything, packs, tab, search = "" }) {
  const open = TABS.includes(tab) ? tab : TABS[0];
  const needle = search.trim().toLowerCase();
  const tabs = TABS.map(key => {
    const all = everything?.[key] ?? [];
    const allowed = CATEGORIES.includes(key) ? all.filter(e => isEntryAllowed(state, key, e.uuid)).length : null;
    return { key, open: key === open, total: all.length, allowed,
      restricted: (key === "packs") ? Array.isArray(state.packs)
        : (key === "abilities") ? (state.abilityMethods.length < ABILITY_METHODS.length)
          : Array.isArray(state.categories[key]) };
  });

  const model = { tabs, open, search, category: null, packs: null, abilities: null,
    warnings: warnings(state, everything) };

  if ( CATEGORIES.includes(open) ) {
    const all = everything?.[open] ?? [];
    const shown = all.filter(e => !needle || String(e.name).toLowerCase().includes(needle));
    model.category = {
      key: open,
      total: all.length,
      allowed: all.filter(e => isEntryAllowed(state, open, e.uuid)).length,
      unrestricted: !Array.isArray(state.categories[open]),
      shown: shown.length,
      entries: shown.map(e => ({ uuid: normalizeUuid(e.uuid), name: e.name, img: e.img ?? null, pack: e.pack,
        allowed: isEntryAllowed(state, open, e.uuid) }))
    };
  } else if ( open === "packs" ) {
    model.packs = {
      unrestricted: !Array.isArray(state.packs),
      entries: packs.map(p => ({ ...p, allowed: !Array.isArray(state.packs) || state.packs.includes(p.collection) }))
    };
  } else {
    model.abilities = ABILITY_METHODS.map(key => ({ key, allowed: state.abilityMethods.includes(key),
      only: state.abilityMethods.length === 1 && state.abilityMethods.includes(key) }));
  }
  return model;
}

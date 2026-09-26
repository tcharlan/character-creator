/**
 * What the GM's "allowed content" screen shows and what a click there changes (PLAN 4.1). Pure: the app
 * (`restrictions-app.mjs`) brings the catalog and writes the settings; everything here is plain data.
 *
 * A category is either **all allowed** (`null`, the default) or an explicit list of UUIDs. Allowing every
 * entry again collapses back to `null`, so a world that never restricts anything stores nothing.
 */

import { CATEGORIES, normalizeUuid } from "../catalog/filters.mjs";
import { ABILITY_METHODS, RANDOM_PARTS, STEPS } from "../contracts.mjs";
import { sigilPath } from "../wizard/splash.mjs";

/** The tabs, in order: one per category, then the packs, the ability-score methods and the backgrounds (D28). */
export const TABS = Object.freeze([...CATEGORIES, "packs", "abilities", "backdrops", "hardcore"]);

/** Categories a character can't be made without. */
export const REQUIRED = Object.freeze(["species", "background", "class"]);

const list = value => (Array.isArray(value) ? value.map(normalizeUuid) : null);

/**
 * The state the screen edits: the stored restrictions plus the allowed methods, as plain arrays.
 * @param {object} restrictions   From the setting (normalised).
 * @param {string[]} abilityMethods
 */
export function editorState(restrictions, abilityMethods, art = {}, stepArt = {}, hardcore = null) {
  const categories = {};
  for ( const category of CATEGORIES ) categories[category] = list(restrictions?.categories?.[category]);
  const pictures = {};
  for ( const [uuid, path] of Object.entries(art ?? {}) ) pictures[normalizeUuid(uuid)] = path;
  return { packs: list(restrictions?.packs), categories, art: pictures, stepArt: { ...(stepArt ?? {}) },
    hardcore: { offered: hardcore?.offered !== false, free: RANDOM_PARTS.filter(p => (hardcore?.free ?? []).includes(p)) },
    abilityMethods: ABILITY_METHODS.filter(m => (abilityMethods ?? ABILITY_METHODS).includes(m)) };
}

/** The GM's own picture for one option (D24); an empty path takes it off again. */
export function setArt(state, uuid, path) {
  const key = normalizeUuid(uuid);
  const next = { ...state.art };
  if ( path ) next[key] = path;
  else delete next[key];
  state.art = next;
  return state;
}

/** The GM's own background for one wizard step (D28); an empty path goes back to the step's emblem. */
export function setStepArt(state, step, path) {
  if ( !STEPS.includes(step) ) return state;
  const next = { ...state.stepArt };
  if ( path ) next[step] = path;
  else delete next[step];
  state.stepArt = next;
  return state;
}

/** Hardcore mode (D31): offer it at all, and hand one of its parts back to the player. */
export function toggleHardcore(state) {
  state.hardcore = { ...state.hardcore, offered: !state.hardcore.offered };
  return state;
}

export function toggleRandomPart(state, part) {
  if ( !RANDOM_PARTS.includes(part) ) return state;
  const free = state.hardcore.free.includes(part)
    ? state.hardcore.free.filter(p => p !== part) : [...state.hardcore.free, part];
  state.hardcore = { ...state.hardcore, free: RANDOM_PARTS.filter(p => free.includes(p)) };
  return state;
}

/** What to store for hardcore mode. */
export function toStoredHardcore(state) {
  return { offered: state?.hardcore?.offered !== false, free: [...(state?.hardcore?.free ?? [])] };
}

/** The step backgrounds to store. */
export function toStoredStepArt(state) {
  return { ...(state?.stepArt ?? {}) };
}

/** The pictures to store: what the GM set, and nothing else. */
export function toStoredArt(state) {
  return { ...(state?.art ?? {}) };
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

/** What is allowed in a category right now, as a set (`null` = everything). */
function allowedSet(state, category, all) {
  const stored = state.categories?.[category];
  return new Set(Array.isArray(stored) ? stored.map(normalizeUuid) : all.map(normalizeUuid));
}

/**
 * Allow everything listed, leaving the rest as it is — the whole of one compendium, say, or one search.
 * @param {string[]} uuids   What to allow.
 * @param {string[]} all     Every UUID in the category, so "all of them" can collapse back to null.
 */
export function allowThese(state, category, uuids, all) {
  const set = allowedSet(state, category, all);
  for ( const uuid of uuids ) set.add(normalizeUuid(uuid));
  state.categories[category] = (set.size >= all.length) ? null : [...set];
  return state;
}

/** Disallow everything listed, leaving the rest as it is. */
export function disallowThese(state, category, uuids, all) {
  const set = allowedSet(state, category, all);
  for ( const uuid of uuids ) set.delete(normalizeUuid(uuid));
  state.categories[category] = [...set];
  return state;
}

/**
 * Options of the same name in more than one compendium (the SRD's Wizard and the Player's Handbook's): the GM
 * should know, since players would see both. Keyed by the name, lowercased and trimmed.
 * @returns {Map<string, { uuid: string, pack: string }[]>}   Only the names that appear more than once.
 */
export function duplicatesOf(entries) {
  const byName = new Map();
  for ( const e of entries ?? [] ) {
    const key = String(e.name ?? "").trim().toLowerCase();
    if ( !key ) continue;
    if ( !byName.has(key) ) byName.set(key, []);
    byName.get(key).push({ uuid: normalizeUuid(e.uuid), pack: e.pack });
  }
  for ( const [key, list] of byName ) if ( list.length < 2 ) byName.delete(key);
  return byName;
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
export function restrictionsModel({ state, everything, packs, tab, search = "", pack = "", onlyDuplicates = false }) {
  const open = TABS.includes(tab) ? tab : TABS[0];
  const needle = search.trim().toLowerCase();
  const tabs = TABS.map(key => {
    const all = everything?.[key] ?? [];
    const allowed = CATEGORIES.includes(key) ? all.filter(e => isEntryAllowed(state, key, e.uuid)).length : null;
    return { key, open: key === open, total: all.length, allowed,
      restricted: (key === "packs") ? Array.isArray(state.packs)
        : (key === "abilities") ? (state.abilityMethods.length < ABILITY_METHODS.length)
          : (key === "backdrops") ? Object.keys(state.stepArt ?? {}).length > 0
            : (key === "hardcore") ? (state.hardcore.free.length > 0) || !state.hardcore.offered
              : Array.isArray(state.categories[key]) };
  });

  const model = { tabs, open, search, category: null, packs: null, abilities: null, backdrops: null, hardcore: null,
    warnings: warnings(state, everything) };

  if ( CATEGORIES.includes(open) ) {
    const all = everything?.[open] ?? [];
    const label = collection => packs?.find(p => p.collection === collection)?.label ?? collection;
    const duplicates = duplicatesOf(all);
    const duplicateUuids = new Set([...duplicates.values()].flat().map(d => d.uuid));
    // The compendiums this category actually comes from, each with how much of it is allowed.
    const fromPacks = [...new Set(all.map(e => e.pack))].map(collection => {
      const mine = all.filter(e => e.pack === collection);
      return { collection, label: label(collection), total: mine.length,
        allowed: mine.filter(e => isEntryAllowed(state, open, e.uuid)).length, selected: collection === pack };
    }).sort((a, b) => a.label.localeCompare(b.label));
    const chosenPack = fromPacks.some(p => p.collection === pack) ? pack : "";
    const shown = all.filter(e => (!needle || String(e.name).toLowerCase().includes(needle))
      && (!chosenPack || (e.pack === chosenPack))
      && (!onlyDuplicates || duplicateUuids.has(normalizeUuid(e.uuid))));
    model.category = {
      key: open,
      total: all.length,
      allowed: all.filter(e => isEntryAllowed(state, open, e.uuid)).length,
      unrestricted: !Array.isArray(state.categories[open]),
      shown: shown.length,
      packs: fromPacks,
      pack: chosenPack,
      onlyDuplicates: !!onlyDuplicates,
      // A filter is on, so "allow these" and "disallow these" act on what the GM can see.
      filtered: !!needle || !!chosenPack || !!onlyDuplicates,
      duplicates: duplicates.size,
      entries: shown.map(e => {
        const uuid = normalizeUuid(e.uuid);
        const own = state.art?.[uuid] ?? null;
        const copies = duplicates.get(String(e.name ?? "").trim().toLowerCase()) ?? [];
        return { uuid, name: e.name, img: own ?? e.img ?? null, pack: e.pack, packLabel: label(e.pack),
          art: own, allowed: isEntryAllowed(state, open, e.uuid),
          duplicate: copies.length > 1,
          // The other compendiums the same name is in, for the warning on the row.
          alsoIn: copies.filter(c => c.uuid !== uuid).map(c => label(c.pack)),
          // Both copies allowed is what the GM should look at; one of each is a choice already made.
          bothAllowed: (copies.length > 1) && copies.every(c => isEntryAllowed(state, open, c.uuid))
        };
      })
    };
  } else if ( open === "packs" ) {
    model.packs = {
      unrestricted: !Array.isArray(state.packs),
      entries: packs.map(p => ({ ...p, allowed: !Array.isArray(state.packs) || state.packs.includes(p.collection) }))
    };
  } else if ( open === "hardcore" ) {
    model.hardcore = {
      offered: state.hardcore.offered,
      // Everything is rolled unless the GM hands it back; the order is the order the dice go in.
      parts: RANDOM_PARTS.map(part => ({ part, free: state.hardcore.free.includes(part) }))
    };
  } else if ( open === "backdrops" ) {
    model.backdrops = STEPS.map(step => {
      const own = state.stepArt?.[step] ?? null;
      return { step, own, img: own ?? sigilPath(step), labelKey: step === "start" ? "Nav.Start" : `Step.${step}.Title` };
    });
  } else {
    model.abilities = ABILITY_METHODS.map(key => ({ key, allowed: state.abilityMethods.includes(key),
      only: state.abilityMethods.length === 1 && state.abilityMethods.includes(key) }));
  }
  return model;
}

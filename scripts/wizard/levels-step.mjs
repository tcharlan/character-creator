/**
 * The class step's levels panel (PLAN 8.4; D32, D35, D37): the character's level and — where the GM allows
 * multiclassing — how the levels are split between classes. Pure: the catalog is read from its index.
 *
 * Every class on offer is a row. The first class (the one picked, or rolled) starts with every level; a level
 * given to another class is taken from it, and a class back at 0 isn't taken at all. The first class always keeps
 * one. The split is worked out on screen and only written to the draft (and the character replayed) when the
 * player confirms it.
 */

import { MULTICLASS_ROOT } from "../contracts.mjs";
import { normalizeUuid } from "../catalog/filters.mjs";

const norm = u => normalizeUuid(u);

/** A class's path root by its catalog entry (`multiclass:<identifier>`), or null. */
export function rootFor(catalog, uuid) {
  const identifier = catalog?.get?.(norm(uuid))?.system?.identifier;
  return identifier ? `${MULTICLASS_ROOT}${identifier}` : null;
}

/** Levels left to the first class by a split. */
export const firstLevels = (level, split = []) => (level ?? 1) - split.reduce((n, m) => n + m.levels, 0);

/** Levels left to the first class in the draft. */
export const firstClassLevels = draft => firstLevels(draft.level, draft.multiclass ?? []);

/**
 * One level more for another class (taken from the first) or one fewer (given back). A class at 0 drops out.
 * Pure: returns the new split.
 * @param {{ uuid: string, levels: number }[]} split
 * @param {string} uuid
 * @param {1|-1} delta
 * @param {number} level        The character level.
 * @param {{ firstMinimum?: number }} [options]   The fewest levels the first class keeps (the GM's, D35).
 */
export function shiftSplit(split, uuid, delta, level, { firstMinimum = 1 } = {}) {
  const list = (split ?? []).map(m => ({ ...m }));
  let entry = list.find(m => norm(m.uuid) === norm(uuid));
  if ( delta > 0 ) {
    if ( firstLevels(level, list) <= Math.max(1, firstMinimum) ) return list;
    if ( !entry ) list.push(entry = { uuid: norm(uuid), levels: 0 });
    entry.levels += 1;
  } else if ( entry ) entry.levels -= 1;
  return list.filter(m => m.levels > 0);
}

/**
 * Put the other classes in order and write them to the draft: no class of the first one's identifier, none
 * twice, at least one level each, and never more than leaves the first class one. Drops the answers and spells
 * of a class no longer taken.
 * @param {object} draft            Mutated in place.
 * @param {object[]} list           `[{ uuid, levels }]`
 * @param {object} catalog
 */
export function setMulticlass(draft, list, catalog, { firstMinimum = 1 } = {}) {
  const firstRoot = rootFor(catalog, draft.picks?.class);
  const seen = new Set(firstRoot ? [firstRoot] : []);
  let room = Math.max(0, (draft.level ?? 1) - Math.max(1, firstMinimum));
  const next = [];
  for ( const m of list ?? [] ) {
    const root = rootFor(catalog, m.uuid);
    const levels = Math.min(Math.max(0, Math.floor(m.levels ?? 0)), room);
    if ( !root || seen.has(root) || (levels < 1) ) continue;
    seen.add(root);
    room -= levels;
    next.push({ uuid: norm(m.uuid), levels });
  }
  const kept = new Set(next.map(m => rootFor(catalog, m.uuid)));
  draft.multiclass = next;
  // A class no longer taken takes its answers and its spells with it; a class with fewer levels keeps its answers
  // (the replay simply doesn't reach the ones past its new level, and the recipe sync drops them).
  draft.recipe.steps = (draft.recipe.steps ?? []).filter(s => !s.path?.[0]?.startsWith(MULTICLASS_ROOT) || kept.has(s.path[0]));
  draft.multiclassSpells = Object.fromEntries(Object.entries(draft.multiclassSpells ?? {}).filter(([root]) => kept.has(root)));
  return draft;
}

/** Is a split the same as the draft's? */
export const sameSplit = (a = [], b = []) => JSON.stringify([...a].map(m => [norm(m.uuid), m.levels]).sort())
  === JSON.stringify([...b].map(m => [norm(m.uuid), m.levels]).sort());

/**
 * The panel.
 * @param {object} draft
 * @param {object} catalog
 * @param {object} [options]
 * @param {boolean} [options.multiclass]   The GM allows multiclassing.
 * @param {object[]|null} [options.split]  The split on screen, not yet confirmed (null: the draft's).
 * @param {string[]|null} [options.offered]  Hardcore (D35): only these classes can be taken.
 * @param {boolean} [options.readOnly]     Nothing can be changed (a rolled character past its stage).
 * @param {(uuid: string) => boolean|null} [options.qualifies]  Whether the character has the 13 for a class now.
 * @returns {null|object}
 */
export function levelsModel(draft, catalog, { multiclass = false, split = null, offered = null, readOnly = false,
  qualifies = () => null, firstMinimum = 1 } = {}) {
  const level = draft.level ?? 1;
  if ( (level <= 1) || !draft.picks?.class ) return null;
  const current = split ?? draft.multiclass ?? [];
  const name = uuid => catalog?.get?.(norm(uuid))?.name ?? String(uuid).split(".").pop();
  const first = { uuid: norm(draft.picks.class), name: name(draft.picks.class), levels: firstLevels(level, current), first: true };
  const firstRoot = rootFor(catalog, draft.picks.class);
  const levelsOf = uuid => current.find(m => norm(m.uuid) === norm(uuid))?.levels ?? 0;
  // The classes that can take levels: those the dice offered, or every allowed class but the first.
  const pool = offered ? offered.map(norm)
    : (multiclass ? (catalog?.byCategory?.class ?? []).map(e => norm(e.uuid)) : []);
  const taken = current.map(m => norm(m.uuid));
  const others = [...new Set([...pool, ...taken])].filter(u => rootFor(catalog, u) !== firstRoot)
    .map(uuid => ({ uuid, name: name(uuid), levels: levelsOf(uuid), qualifies: qualifies(uuid) }))
    // A fixed order (by name): rows that moved when a level was added would put the next click on another class.
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(o => ({ ...o, canRaise: !readOnly && (first.levels > Math.max(1, firstMinimum)), canLower: !readOnly && (o.levels > 0) }));
  return {
    level, first, others, multiclass: !!(multiclass || offered), readOnly, firstMinimum: Math.max(1, firstMinimum),
    dirty: !sameSplit(current, draft.multiclass ?? []),
    line: [first, ...others.filter(o => o.levels > 0)].map(c => `${c.name} ${c.levels}`).join(" / ")
  };
}

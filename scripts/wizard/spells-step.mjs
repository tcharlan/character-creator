/**
 * The Spells step (PLAN 3.6; above level 1, 8.4): cantrips and spells in the shape the class uses — prepared,
 * known, or a spellbook with a prepared subset — up to the highest level that class casts. A multiclassed
 * character chooses for each casting class on its own (`root`). The counts and lists come from
 * `rules/spells.mjs` and `spell-facts.mjs`; this shapes them for the screen and turns a click into a selection.
 */

import { normalizeSelection } from "../rules/spells.mjs";

/** A class's selection in the draft: the first class's is `spells`, another's in `multiclassSpells`. */
const selectionOf = (draft, root) => normalizeSelection(root === "class" ? draft?.spells : draft?.multiclassSpells?.[root]);

/** The lists a class fills in, in the order they're shown. */
export function tabsFor(req) {
  if ( !req?.caster ) return [];
  const tabs = [];
  if ( req.cantrips ) tabs.push({ key: "cantrips", needed: req.cantrips });
  if ( req.spellbook ) {
    tabs.push({ key: "spellbook", needed: req.spellbook });
    if ( req.spells ) tabs.push({ key: "spells", needed: req.spells, fromSpellbook: true });
  } else if ( req.spells ) tabs.push({ key: "spells", needed: req.spells });
  return tabs;
}

/**
 * The screen's model.
 * @param {object} context              From spellContext(): { req, options, owned }.
 * @param {object} draft
 * @param {string|null} [openTab]       Which list is open (defaults to the first that isn't finished).
 * @param {object} [catalog]            For names and images.
 */
export function spellsModel({ req, options, owned = new Set() }, draft, openTab = null, catalog = null, root = "class",
  { taken = new Map(), className = name => name } = {}) {
  const selection = selectionOf(draft, root);
  const tabs = tabsFor(req).map(t => ({
    ...t,
    chosen: selection[t.key].length,
    complete: t.key === "spells" ? selection.spells.length === t.needed : selection[t.key].length === t.needed
  }));
  const open = tabs.find(t => t.key === openTab) ?? tabs.find(t => !t.complete) ?? tabs[0] ?? null;

  let list = [];
  if ( open ) {
    // Leveled spells up to the highest level the class casts, lowest level first.
    const castable = (options.leveled ?? options.level1 ?? [])
      .filter(u => (options.levels?.get?.(u) ?? 1) <= Math.max(1, req.maxLevel ?? 1));
    const pool = open.key === "cantrips" ? options.cantrips
      : open.fromSpellbook ? selection.spellbook
        : castable;
    const chosen = selection[open.key];
    list = pool.map(uuid => {
      const entry = catalog?.get?.(uuid);
      const selected = chosen.includes(uuid);
      return {
        uuid, name: entry?.name ?? uuid.split(".").pop(), img: entry?.img ?? null, selected,
        level: options.levels?.get?.(uuid) ?? entry?.system?.level ?? 0,
        already: owned.has(uuid),
        // Chosen for another of the character's classes (a multiclassed caster): it counts there, not twice.
        takenBy: (!selected && taken.has(uuid)) ? className(taken.get(uuid)) : null,
        disabled: owned.has(uuid) || (!selected && taken.has(uuid)) || (!selected && (chosen.length >= open.needed))
      };
    }).sort((a, b) => (a.level - b.level) || a.name.localeCompare(b.name));
  }

  return {
    caster: !!req?.caster,
    mode: req?.mode ?? "none",
    method: req?.method ?? null,
    maxLevel: req?.maxLevel ?? 0,
    tabs: tabs.map(t => ({ ...t, open: t.key === open?.key })),
    open: open ? { ...open, list } : null,
    known: [...owned].map(uuid => catalog?.get?.(uuid)?.name ?? uuid.split(".").pop()).sort(),
    complete: tabs.every(t => t.complete)
  };
}

/**
 * Click a spell in one of the lists. Returns the new `draft.spells`, or null when the click changes nothing
 * (a spell the character already has, or one pick too many).
 * @param {object} draft
 * @param {"cantrips"|"spells"|"spellbook"} kind
 * @param {string} uuid
 * @param {object} req                  From requirements().
 * @param {Set<string>} [owned]
 */
export function toggleSpell(draft, kind, uuid, req, owned = new Set(), root = "class", taken = new Map()) {
  if ( owned.has(uuid) ) return null;
  const selection = selectionOf(draft, root);
  const list = [...selection[kind]];
  const at = list.indexOf(uuid);
  const needed = kind === "cantrips" ? req.cantrips : kind === "spellbook" ? req.spellbook : req.spells;
  if ( at >= 0 ) list.splice(at, 1);
  else {
    if ( list.length >= needed ) return null;
    if ( taken.has(uuid) ) return null;
    // A prepared spell has to be in the spellbook, where the class has one.
    if ( (kind === "spells") && req.spellbook && !selection.spellbook.includes(uuid) ) return null;
    list.push(uuid);
  }
  const next = { ...selection, [kind]: list };
  // Dropping a spell from the book unprepares it too.
  if ( (kind === "spellbook") && (at >= 0) ) next.spells = next.spells.filter(u => u !== uuid);
  if ( root === "class" ) draft.spells = next;
  else draft.multiclassSpells = { ...(draft.multiclassSpells ?? {}), [root]: next };
  return next;
}

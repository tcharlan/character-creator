/**
 * Class spells (PLAN 2.5, from spike 1.7; above level 1, PLAN 8.2b). Pure: no Foundry globals. The numbers come
 * from dnd5e's class data on the built character (read in `spell-facts.mjs`), one class at a time; the only rules
 * table here is the Wizard's spellbook size, which dnd5e's data doesn't carry.
 */

import { makeError } from "../contracts.mjs";
import { normalizeUuid } from "../catalog/filters.mjs";

/**
 * Rules gap (convention 2): dnd5e's class data has no spellbook size.
 * Source: 2014 PHB, Wizard → Spellcasting → Spellbook ("six 1st-level wizard spells of your choice") and
 * "Learning Spells of 1st Level and Higher" ("Each time you gain a wizard level, you can add two wizard spells
 * of your choice to your spellbook"); 2024 PHB, Wizard → Spellcasting → Spellbook ("six level 1 Wizard spells")
 * and "Expanding the Spellbook" ("Whenever you gain a Wizard level after 1, add two Wizard spells").
 * Keyed by class identifier. Spells copied from scrolls are the player's business at the table, not here.
 */
export const SPELLBOOK = Object.freeze({ wizard: Object.freeze({ first: 6, perLevel: 2 }) });

/** Spellbook size for a class at a class level (0 for a class without one). */
export function spellbookSize(identifier, classLevel = 1) {
  const book = SPELLBOOK[identifier];
  return book ? book.first + (book.perLevel * (Math.max(1, classLevel) - 1)) : 0;
}

/**
 * What a character chooses for one class, from the class facts (spell-facts.mjs):
 * `{ identifier, classLevel, maxLevel, type, preparation: { formula, max }, scale, slots }`. `maxLevel` is the
 * highest spell level that class casts on its own (0: no leveled spells yet).
 * @returns {{ caster, method, mode: "prepared"|"known"|"none", cantrips, spells, spellbook, maxLevel }}
 */
export function requirements(facts) {
  const scale = facts.scale ?? {};
  // The class's own highest spell level; older facts (level 1) only carried the slots.
  const maxLevel = facts.maxLevel ?? (((facts.slots?.spell1 ?? 0) + (facts.slots?.pact ?? 0))
    ? Math.max(1, facts.slots?.pactLevel ?? 0) : 0);
  const cantrips = Number(scale["cantrips-known"] ?? 0) || 0;
  const hasFormula = !!facts.preparation?.formula;
  const known = Number(scale["spells-known"] ?? 0) || 0;
  // Without slots (2014 Paladin/Ranger at level 1) there are no leveled spells, whatever the formula says.
  const mode = !maxLevel ? "none" : hasFormula ? "prepared" : known ? "known" : "none";
  const spells = mode === "prepared" ? Math.max(0, facts.preparation.max ?? 0) : mode === "known" ? known : 0;
  const spellbook = maxLevel ? spellbookSize(facts.identifier, facts.classLevel ?? 1) : 0;
  return { caster: !!(maxLevel || cantrips), method: facts.type ?? null, mode, cantrips, spells, spellbook, maxLevel };
}

/** A selection with normalised UUIDs and every list present. */
export function normalizeSelection(sel = {}) {
  const list = v => (Array.isArray(v) ? v.map(u => normalizeUuid(u)) : []);
  return { cantrips: list(sel?.cantrips), spells: list(sel?.spells), spellbook: list(sel?.spellbook) };
}

/**
 * Validate a spell selection.
 * @param {object} req                 From requirements().
 * @param {{ cantrips?: string[], spells?: string[], spellbook?: string[] }} selection
 *   `spells` = prepared or known spells; for a spellbook class they must also be in `spellbook`.
 * @param {object} context
 * @param {Set<string>} context.list     Allowed UUIDs: the class list within the catalog (normalised).
 * @param {Map<string, number>} context.levels  UUID → spell level.
 * @param {Set<string>} [context.owned]  Spells the character already has from other sources (normalised).
 * @returns {object[]} makeError() objects
 */
export function validateSpells(req, selection, { list = new Set(), levels = new Map(), owned = new Set() } = {}) {
  const errors = [];
  const fail = (code, detail) => errors.push(makeError(code, detail));
  const { cantrips, spells, spellbook: book } = normalizeSelection(selection);

  if ( !req.caster ) {
    if ( cantrips.length || spells.length || book.length ) fail("NOT_A_CASTER");
    return errors;
  }
  if ( cantrips.length !== req.cantrips ) fail("CANTRIP_COUNT", { chosen: cantrips.length, needed: req.cantrips });
  if ( req.spellbook ) {
    if ( book.length !== req.spellbook ) fail("SPELLBOOK_COUNT", { chosen: book.length, needed: req.spellbook });
    const notInBook = spells.filter(u => !book.includes(u));
    if ( notInBook.length ) fail("NOT_IN_SPELLBOOK", notInBook);
  } else if ( book.length ) fail("SPELLBOOK_COUNT", { chosen: book.length, needed: 0 });
  // Known spells: exactly the number known. Prepared: up to the maximum.
  const tooMany = spells.length > req.spells;
  const tooFew = req.mode === "known" && spells.length < req.spells;
  if ( tooMany || tooFew ) fail("SPELL_COUNT", { chosen: spells.length, needed: req.spells, mode: req.mode });

  const checked = new Set();
  for ( const [uuid, want] of [...cantrips.map(u => [u, "cantrip"]), ...[...spells, ...book].map(u => [u, "leveled"])] ) {
    if ( checked.has(uuid) ) continue;
    checked.add(uuid);
    if ( !list.has(uuid) ) fail("NOT_ON_LIST", uuid);
    const lvl = levels.get(uuid);
    const ok = want === "cantrip" ? lvl === 0 : (lvl >= 1 && lvl <= req.maxLevel);
    if ( !ok ) fail("WRONG_LEVEL", { uuid, level: lvl ?? null });
  }
  for ( const l of [cantrips, spells, book] ) {
    const dup = l.filter((u, i) => l.indexOf(u) !== i);
    if ( dup.length ) fail("DUPLICATE", dup);
  }
  const again = [...checked].filter(u => owned.has(u));
  if ( again.length ) fail("ALREADY_KNOWN", again);
  return errors;
}

/**
 * How each chosen spell is stored on the actor (dnd5e 5.3 SpellData): `prepared` 0 = unprepared,
 * 1 = prepared (counts toward the class maximum), 2 = always. Cantrips 1; prepared/known per mode;
 * spellbook spells not prepared 0.
 * @returns {{ uuid, prepared }[]}
 */
export function spellStates(req, selection) {
  const { cantrips, spells, spellbook } = normalizeSelection(selection);
  const out = cantrips.map(uuid => ({ uuid, prepared: 1 }));
  if ( req.spellbook ) {
    const prepared = new Set(spells);
    for ( const uuid of spellbook ) out.push({ uuid, prepared: prepared.has(uuid) ? 1 : 0 });
  } else {
    // Known casters have no preparation maximum in dnd5e's data; "always" keeps its counter at 0/0.
    for ( const uuid of spells ) out.push({ uuid, prepared: req.mode === "known" ? 2 : 1 });
  }
  return out;
}

/**
 * A default selection from the options (first ones in order), skipping owned spells. Tests use it, and it's
 * the D4 model: when the options number exactly what's needed, this is the only legal selection.
 * @param {object} req
 * @param {{ cantrips: string[], level1: string[], leveled?: string[], levels?: Map<string, number> }} options
 *   Allowed UUIDs by level, in display order; `leveled` is every leveled spell on the list.
 * @param {Set<string>} [owned]
 */
export function defaultSpells(req, { cantrips = [], level1 = [], leveled = null, levels = new Map() }, owned = new Set()) {
  if ( !req.caster ) return { cantrips: [], spells: [], spellbook: [] };
  const free = l => l.map(u => normalizeUuid(u)).filter(u => !owned.has(u));
  const c = free(cantrips).slice(0, req.cantrips);
  const castable = (leveled ?? level1).filter(u => (levels.get(normalizeUuid(u)) ?? 1) <= req.maxLevel);
  const l1 = req.maxLevel ? free(castable) : [];
  const spellbook = l1.slice(0, req.spellbook);
  return { cantrips: c, spellbook, spells: (req.spellbook ? spellbook : l1).slice(0, req.spells) };
}

/**
 * Level-1 class spells (PLAN 2.5, from spike 1.7). Pure: no Foundry globals. The numbers come from dnd5e's
 * class data on the built character (read in `spell-facts.mjs`); the only rules table here is the Wizard's
 * spellbook size, which dnd5e's data doesn't carry.
 */

import { makeError } from "../contracts.mjs";
import { normalizeUuid } from "../catalog/filters.mjs";

/**
 * Rules gap (convention 2): dnd5e's class data has no spellbook size.
 * Source: 2014 PHB, Wizard → Spellcasting → Spellbook ("six 1st-level wizard spells of your choice");
 * 2024 PHB, Wizard → Spellcasting → Spellbook ("six level 1 Wizard spells of your choice").
 * Keyed by class identifier.
 */
export const SPELLBOOK_SIZE_AT_LEVEL_1 = Object.freeze({ wizard: 6 });

/**
 * What a level-1 character of this class chooses, from the class facts (spell-facts.mjs):
 * `{ identifier, type, preparation: { formula, max }, scale, slots: { spell1, pact, pactLevel } }`.
 * @returns {{ caster, method, mode: "prepared"|"known"|"none", cantrips, spells, spellbook, maxLevel }}
 */
export function requirements(facts) {
  const scale = facts.scale ?? {};
  const slots = (facts.slots?.spell1 ?? 0) + (facts.slots?.pact ?? 0);
  const cantrips = Number(scale["cantrips-known"] ?? 0) || 0;
  const hasFormula = !!facts.preparation?.formula;
  const known = Number(scale["spells-known"] ?? 0) || 0;
  // Without slots at level 1 (2014 Paladin/Ranger) there are no leveled spells, whatever the formula says.
  const mode = !slots ? "none" : hasFormula ? "prepared" : known ? "known" : "none";
  const spells = mode === "prepared" ? Math.max(0, facts.preparation.max ?? 0) : mode === "known" ? known : 0;
  const spellbook = slots ? (SPELLBOOK_SIZE_AT_LEVEL_1[facts.identifier] ?? 0) : 0;
  return {
    caster: !!(slots || cantrips), method: facts.type ?? null, mode, cantrips, spells, spellbook,
    maxLevel: slots ? Math.max(1, facts.slots?.pactLevel ?? 0) : 0
  };
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
 * @param {{ cantrips: string[], level1: string[] }} options   Allowed UUIDs by level, in display order.
 * @param {Set<string>} [owned]
 */
export function defaultSpells(req, { cantrips = [], level1 = [] }, owned = new Set()) {
  if ( !req.caster ) return { cantrips: [], spells: [], spellbook: [] };
  const free = l => l.map(u => normalizeUuid(u)).filter(u => !owned.has(u));
  const c = free(cantrips).slice(0, req.cantrips);
  const l1 = req.maxLevel ? free(level1) : [];
  const spellbook = l1.slice(0, req.spellbook);
  return { cantrips: c, spellbook, spells: (req.spellbook ? spellbook : l1).slice(0, req.spells) };
}

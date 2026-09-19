/*
 * SPIKE 1.7 — throwaway. Pure logic (no Foundry globals): level-1 spell requirements and validation.
 * The numbers come from dnd5e's class data (read in spike/spells.mjs); the only table here is the
 * Wizard's spellbook size, which dnd5e's data doesn't carry.
 */

/**
 * Rules gap (convention 2): dnd5e's class data has no spellbook size.
 * Source: 2014 PHB, Wizard → Spellcasting → Spellbook ("six 1st-level wizard spells of your choice");
 * 2024 PHB, Wizard → Spellcasting → Spellbook ("six level 1 Wizard spells of your choice").
 * Keyed by class identifier; the real module moves this to scripts/rules/.
 */
export const SPELLBOOK_SIZE_AT_LEVEL_1 = { wizard: 6 };

export const SPELL_ERRORS = {
  NOT_A_CASTER: "NOT_A_CASTER",
  CANTRIP_COUNT: "CANTRIP_COUNT",
  SPELL_COUNT: "SPELL_COUNT",
  SPELLBOOK_COUNT: "SPELLBOOK_COUNT",
  NOT_IN_SPELLBOOK: "NOT_IN_SPELLBOOK",
  NOT_ON_LIST: "NOT_ON_LIST",
  WRONG_LEVEL: "WRONG_LEVEL",
  DUPLICATE: "DUPLICATE"
};
const E = SPELL_ERRORS;

/**
 * What a level-1 character of this class chooses, from the class facts (spike/spells.mjs):
 * `{ progression, type, identifier, preparation: { formula, max }, scale, slots: { spell1, pact, pactLevel } }`.
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

/**
 * Validate a spell selection against the requirements, the class list and spell levels.
 * @param {object} req                 From requirements().
 * @param {{ cantrips?: string[], spells?: string[], spellbook?: string[] }} sel
 *   `spells` = prepared or known spells; for a spellbook class they must also be in `spellbook`.
 * @param {Set<string>} classList      UUIDs on the class list (normalised).
 * @param {Map<string, number>} levels UUID → spell level.
 */
export function validateSpells(req, sel = {}, classList = new Set(), levels = new Map()) {
  const errors = [];
  const fail = (code, detail) => errors.push({ code, detail });
  const cantrips = sel.cantrips ?? [];
  const spells = sel.spells ?? [];
  const book = sel.spellbook ?? [];

  if ( !req.caster ) {
    if ( cantrips.length || spells.length || book.length ) fail(E.NOT_A_CASTER);
    return errors;
  }
  if ( cantrips.length !== req.cantrips ) fail(E.CANTRIP_COUNT, { chosen: cantrips.length, needed: req.cantrips });
  if ( req.spellbook ) {
    if ( book.length !== req.spellbook ) fail(E.SPELLBOOK_COUNT, { chosen: book.length, needed: req.spellbook });
    const notInBook = spells.filter(u => !book.includes(u));
    if ( notInBook.length ) fail(E.NOT_IN_SPELLBOOK, notInBook);
  } else if ( book.length ) fail(E.SPELLBOOK_COUNT, { chosen: book.length, needed: 0 });
  // Known spells: exactly the number known. Prepared: up to the maximum.
  const tooMany = spells.length > req.spells;
  const tooFew = req.mode === "known" && spells.length < req.spells;
  if ( tooMany || tooFew ) fail(E.SPELL_COUNT, { chosen: spells.length, needed: req.spells, mode: req.mode });

  for ( const [uuid, want] of [...cantrips.map(u => [u, "cantrip"]), ...[...spells, ...book].map(u => [u, "leveled"])] ) {
    if ( !classList.has(uuid) ) fail(E.NOT_ON_LIST, uuid);
    const lvl = levels.get(uuid);
    const ok = want === "cantrip" ? lvl === 0 : (lvl >= 1 && lvl <= req.maxLevel);
    if ( !ok ) fail(E.WRONG_LEVEL, { uuid, level: lvl ?? null });
  }
  for ( const list of [cantrips, spells, book] ) {
    const dup = list.filter((u, i) => list.indexOf(u) !== i);
    if ( dup.length ) fail(E.DUPLICATE, dup);
  }
  return errors;
}

/**
 * How each chosen spell is stored on the actor (dnd5e 5.3 SpellData): `prepared` 0 = unprepared,
 * 1 = prepared (counts toward the class maximum), 2 = always. Cantrips 1; prepared/known per mode;
 * spellbook spells not prepared 0.
 * @returns {{ uuid, prepared }[]}
 */
export function spellStates(req, sel = {}) {
  const out = [];
  const spells = new Set(sel.spells ?? []);
  for ( const u of sel.cantrips ?? [] ) out.push({ uuid: u, prepared: 1 });
  if ( req.spellbook ) {
    for ( const u of sel.spellbook ?? [] ) out.push({ uuid: u, prepared: spells.has(u) ? 1 : 0 });
  } else {
    // Known casters have no preparation maximum in dnd5e's data; "always" keeps its counter at 0/0.
    for ( const u of spells ) out.push({ uuid: u, prepared: req.mode === "known" ? 2 : 1 });
  }
  return out;
}

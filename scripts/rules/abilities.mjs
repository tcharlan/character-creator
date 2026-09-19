/**
 * Ability score methods (PLAN 2.4). Pure: no Foundry globals, so the wizard, the GM's validator and the
 * unit tests share it.
 *
 * dnd5e has no point-buy or standard-array helper (RESEARCH.md → What dnd5e does NOT provide), so this is one of the few
 * rules tables the module keeps itself (convention 2). Source: Player's Handbook 2014 ("Variant:
 * Customizing Ability Scores") and 2024 (chapter 2, "Generate Your Scores") — both rule sets use the
 * same numbers.
 */

import { ABILITIES, ABILITY_METHODS, makeError } from "../contracts.mjs";

/** Point buy: 27 points, each score 8–15. */
export const POINT_BUY = Object.freeze({
  budget: 27, min: 8, max: 15,
  cost: Object.freeze({ 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 })
});

/** Standard array: each score used exactly once. */
export const STANDARD_ARRAY = Object.freeze([15, 14, 13, 12, 10, 8]);

/** Rolled: 4d6, drop the lowest, six times (D15: rolled in the player's browser, posted to chat). */
export const ABILITY_ROLL = Object.freeze({ formula: "4d6kh3", count: 6, number: 4, faces: 6, keep: 3 });

/** The chat message flag that ties a roll to one draft (`flags[MODULE_ID].roll`). */
export const ROLL_FLAG = "roll";
export const ROLL_PURPOSE = Object.freeze({ ABILITIES: "abilities" });

/** The server stamps a new message's createdTime and modifiedTime separately (≈1 ms apart); a later edit moves modifiedTime further. */
export const EDIT_TOLERANCE_MS = 1000;

const sorted = list => [...list].sort((a, b) => a - b);
const sameMultiset = (a, b) => a.length === b.length && sorted(a).every((v, i) => v === sorted(b)[i]);
const scoresOf = base => ABILITIES.map(k => base?.[k]);

/**
 * Points spent on a point-buy spread.
 * @param {Record<string, number>} base
 * @returns {{ spent: number, remaining: number, outOfRange: string[] }}
 */
export function pointBuyCost(base) {
  let spent = 0;
  const outOfRange = [];
  for ( const k of ABILITIES ) {
    const cost = Number.isInteger(base?.[k]) ? POINT_BUY.cost[base[k]] : undefined;
    if ( cost === undefined ) outOfRange.push(k);
    else spent += cost;
  }
  return { spent, remaining: POINT_BUY.budget - spent, outOfRange };
}

/**
 * Check the draft's ability scores for their method. The recorded roll itself (the chat message) is
 * checked by `checkRollRecord`; here only the scores against the draft's copy of the results.
 * @param {{ method, base, roll }} abilities       draft.abilities
 * @param {object} [options]
 * @param {string[]} [options.allowedMethods]     The GM's allowed methods (PLAN 2.10).
 * @returns {object[]} makeError() objects
 */
export function checkAbilities(abilities, { allowedMethods = ABILITY_METHODS } = {}) {
  const { method = null, base = null, roll = null } = abilities ?? {};
  if ( !ABILITY_METHODS.includes(method) || !allowedMethods.includes(method) ) {
    return [makeError("ABILITY_METHOD_NOT_ALLOWED", { method, allowed: [...allowedMethods] })];
  }
  // A10: rolled results lock in — rolling and then switching to another method isn't allowed.
  if ( roll && method !== "rolled" ) return [makeError("ROLL_INVALID", { rolledButMethod: method })];

  const scores = scoresOf(base);
  const missing = ABILITIES.filter((k, i) => !Number.isInteger(scores[i]));
  switch ( method ) {
    case "pointBuy": {
      const { spent, outOfRange } = pointBuyCost(base);
      if ( outOfRange.length || spent !== POINT_BUY.budget ) {
        return [makeError("POINT_BUY_INVALID", { spent, budget: POINT_BUY.budget, outOfRange })];
      }
      return [];
    }
    case "standardArray":
      if ( missing.length || !sameMultiset(scores, STANDARD_ARRAY) ) {
        return [makeError("STANDARD_ARRAY_INVALID", { scores, expected: [...STANDARD_ARRAY] })];
      }
      return [];
    case "rolled": {
      const results = roll?.results;
      if ( !roll || !Array.isArray(results) || results.length !== ABILITY_ROLL.count ) {
        return [makeError("ROLL_INVALID", { notRolled: true })];
      }
      if ( missing.length || !sameMultiset(scores, results) ) {
        return [makeError("ROLL_INVALID", { scores, results: [...results] })];
      }
      return [];
    }
  }
  return [];
}

/**
 * Check a recorded roll (a plain copy of the chat message — see ability-roll.mjs `readRollRecord`)
 * against the draft. Tamper-evident, not tamper-proof (D15): it catches edited, reused, re-rolled or
 * hand-made messages, not a modified client.
 * @param {object|null} record   { id, authorId, public, flag: { draftId, purpose }, created, modified, rolls: [{ formula,
 *                               total, dice: [{ number, faces, results: [{ result, active }] }] }] }
 * @param {object} expected
 * @param {string} expected.draftId
 * @param {string} expected.userId      The draft's owner.
 * @param {number[]} expected.results   draft.abilities.roll.results, in roll order.
 * @param {string[]} [expected.others]  Ids of other ability-roll messages for this draft by this user.
 * @returns {object[]} makeError() objects
 */
export function checkRollRecord(record, { draftId, userId, results, others = [] }) {
  const fail = detail => [makeError("ROLL_INVALID", detail)];
  if ( !record ) return fail({ message: "missing" });
  if ( record.authorId !== userId ) return fail({ message: "wrongAuthor" });
  if ( record.flag?.draftId !== draftId || record.flag?.purpose !== ROLL_PURPOSE.ABILITIES ) return fail({ message: "wrongDraft" });
  if ( !record.public ) return fail({ message: "notPublic" });
  if ( !(Math.abs((record.modified ?? NaN) - (record.created ?? NaN)) <= EDIT_TOLERANCE_MS) ) return fail({ message: "edited" });
  // A10: one roll per draft. Any other roll for the same draft means it was re-rolled.
  if ( others.length ) return fail({ message: "rerolled", others: [...others] });

  const rolls = record.rolls ?? [];
  if ( rolls.length !== ABILITY_ROLL.count ) return fail({ message: "rollCount", count: rolls.length });
  const totals = [];
  for ( const [i, roll] of rolls.entries() ) {
    const problem = checkOneRoll(roll);
    if ( problem ) return fail({ message: "badRoll", roll: i, problem });
    totals.push(roll.total);
  }
  if ( !Array.isArray(results) || results.length !== totals.length || results.some((v, i) => v !== totals[i]) ) {
    return fail({ message: "resultsDiffer", recorded: totals, draft: Array.isArray(results) ? [...results] : results });
  }
  return [];
}

/** Is this one 4d6-drop-lowest roll internally consistent? Returns a problem string or null. */
function checkOneRoll(roll) {
  if ( roll?.formula !== ABILITY_ROLL.formula ) return "formula";
  if ( roll.dice?.length !== 1 ) return "dice";
  const [die] = roll.dice;
  if ( die.number !== ABILITY_ROLL.number || die.faces !== ABILITY_ROLL.faces ) return "dice";
  const values = (die.results ?? []).map(r => r.result);
  if ( values.length !== ABILITY_ROLL.number || values.some(v => !Number.isInteger(v) || v < 1 || v > ABILITY_ROLL.faces) ) return "faces";
  const kept = die.results.filter(r => r.active).map(r => r.result);
  const highest = sorted(values).slice(-ABILITY_ROLL.keep);
  if ( !sameMultiset(kept, highest) ) return "kept";
  const sum = kept.reduce((a, b) => a + b, 0);
  if ( roll.total !== sum ) return "total";
  return null;
}

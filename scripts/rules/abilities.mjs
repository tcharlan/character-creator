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
import { ROLL_PURPOSE, checkRecord, sameMultiset } from "./roll-record.mjs";

export { ROLL_FLAG, ROLL_PURPOSE, EDIT_TOLERANCE_MS } from "./roll-record.mjs";

/** Point buy: 27 points, each score 8–15. */
export const POINT_BUY = Object.freeze({
  budget: 27, min: 8, max: 15,
  cost: Object.freeze({ 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 })
});

/** Standard array: each score used exactly once. */
export const STANDARD_ARRAY = Object.freeze([15, 14, 13, 12, 10, 8]);

/** Rolled: 4d6, drop the lowest, six times (D15: rolled in the player's browser, posted to chat). */
export const ABILITY_ROLL = Object.freeze({ formula: "4d6kh3", count: 6, number: 4, faces: 6, keep: 3 });

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
  // Nothing chosen yet is a step still to do, not a refusal: the two read very differently to a player.
  if ( (method === null) || (method === undefined) ) return [makeError("ABILITY_METHOD_MISSING")];
  if ( !ABILITY_METHODS.includes(method) || !allowedMethods.includes(method) ) {
    return [makeError("ABILITY_METHOD_NOT_ALLOWED", { method, allowed: [...allowedMethods] })];
  }
  // D26: a roll stays with the draft even when another method is chosen — it is simply not used. One roll per
  // draft still holds (A10), which is what the chat record checks.

  const scores = scoresOf(base);
  const missing = ABILITIES.filter((k, i) => !Number.isInteger(scores[i]));
  switch ( method ) {
    case "pointBuy": {
      const { spent, outOfRange } = pointBuyCost(base);
      // Points still to spend is work in progress; spending too many, or leaving the 8–15 range, is not.
      if ( outOfRange.length || (spent > POINT_BUY.budget) ) {
        return [makeError("POINT_BUY_INVALID", { spent, budget: POINT_BUY.budget, outOfRange })];
      }
      if ( spent < POINT_BUY.budget ) {
        return [makeError("ABILITY_SCORES_MISSING", { method, spent, budget: POINT_BUY.budget })];
      }
      return [];
    }
    case "standardArray":
      if ( missing.length ) return [makeError("ABILITY_SCORES_MISSING", { method, missing })];
      if ( !sameMultiset(scores, STANDARD_ARRAY) ) {
        return [makeError("STANDARD_ARRAY_INVALID", { scores, expected: [...STANDARD_ARRAY] })];
      }
      return [];
    case "rolled": {
      const results = roll?.results;
      if ( !roll || !Array.isArray(results) || results.length !== ABILITY_ROLL.count ) {
        return [makeError("ABILITY_SCORES_MISSING", { method, notRolled: true })];
      }
      if ( missing.length ) return [makeError("ABILITY_SCORES_MISSING", { method, missing })];
      if ( !sameMultiset(scores, results) ) {
        return [makeError("ROLL_INVALID", { scores, results: [...results] })];
      }
      return [];
    }
  }
  return [];
}

/**
 * Check a recorded ability roll (a plain copy of the chat message — roll-messages.mjs `readRollRecord`)
 * against the draft: see roll-record.mjs `checkRecord`.
 * @param {object|null} record
 * @param {{ draftId: string, userId: string, results: number[], others?: string[] }} expected
 *   `results`: draft.abilities.roll.results, in roll order; `others`: other ability rolls for this draft.
 * @returns {object[]} makeError() objects
 */
export function checkRollRecord(record, { draftId, userId, results, others = [] }) {
  return checkRecord(record, { code: "ROLL_INVALID", draftId, userId, purpose: ROLL_PURPOSE.ABILITIES, spec: ABILITY_ROLL,
    count: ABILITY_ROLL.count, results, others });
}

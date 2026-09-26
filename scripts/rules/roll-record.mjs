/**
 * Recorded rolls (D15): a roll made in the player's browser and posted to chat, flagged with the draft id,
 * then checked by the GM against what the draft claims. Pure — `roll-messages.mjs` turns a ChatMessage into
 * the plain record checked here. Used for rolled ability scores (A10) and 2014 rolled starting wealth.
 *
 * Tamper-evident, not tamper-proof: it catches edited, reused, re-rolled or hand-made messages, not a
 * modified client.
 */

import { makeError } from "../contracts.mjs";

/** The chat message flag that ties a roll to one draft (`flags[MODULE_ID].roll`). */
export const ROLL_FLAG = "roll";
export const ROLL_PURPOSE = Object.freeze({ ABILITIES: "abilities", WEALTH: "wealth", RANDOM: "random" });

/** The server stamps a new message's createdTime and modifiedTime separately (≈1 ms apart); a later edit moves modifiedTime further. */
export const EDIT_TOLERANCE_MS = 1000;

const sorted = list => [...list].sort((a, b) => a - b);
export const sameMultiset = (a, b) => a.length === b.length && sorted(a).every((v, i) => v === sorted(b)[i]);

/**
 * Check a roll record against the draft.
 * @param {object|null} record   { id, authorId, public, flag: { draftId, purpose, source? }, created, modified,
 *                               rolls: [{ formula, total, dice: [{ number, faces, results: [{ result, active }] }] }] }
 * @param {object} expected
 * @param {string} expected.code        Error code to report (ROLL_INVALID, WEALTH_ROLL_INVALID).
 * @param {string} expected.draftId
 * @param {string} expected.userId      The draft's owner.
 * @param {string} expected.purpose     ROLL_PURPOSE value.
 * @param {string} [expected.source]    For wealth: "class" or "background".
 * @param {object} expected.spec        Each roll: { number, faces, keep?, multiplier?, formula? } (see checkDiceRoll).
 * @param {number} expected.count       How many rolls the message holds.
 * @param {number[]} expected.results   The totals the draft claims, in roll order.
 * @param {string[]} [expected.others]  Ids of other messages for the same draft, purpose and source (re-rolls).
 * @returns {object[]} makeError() objects
 */
export function checkRecord(record, { code, draftId, userId, purpose, source, spec, count, results, others = [] }) {
  const fail = detail => [makeError(code, detail)];
  if ( !record ) return fail({ message: "missing" });
  if ( record.authorId !== userId ) return fail({ message: "wrongAuthor" });
  const f = record.flag;
  if ( f?.draftId !== draftId || f?.purpose !== purpose || (source !== undefined && f?.source !== source) ) {
    return fail({ message: "wrongDraft" });
  }
  if ( !record.public ) return fail({ message: "notPublic" });
  if ( !(Math.abs((record.modified ?? NaN) - (record.created ?? NaN)) <= EDIT_TOLERANCE_MS) ) return fail({ message: "edited" });
  // One roll per draft (and source): any other on record means it was re-rolled (A10).
  if ( others.length ) return fail({ message: "rerolled", others: [...others] });

  const rolls = record.rolls ?? [];
  if ( rolls.length !== count ) return fail({ message: "rollCount", count: rolls.length, expected: count });
  const totals = [];
  for ( const [i, roll] of rolls.entries() ) {
    const problem = checkDiceRoll(roll, spec);
    if ( problem ) return fail({ message: "badRoll", roll: i, problem });
    totals.push(roll.total);
  }
  if ( !Array.isArray(results) || results.length !== totals.length || results.some((v, i) => v !== totals[i]) ) {
    return fail({ message: "resultsDiffer", recorded: totals, draft: Array.isArray(results) ? [...results] : results });
  }
  return [];
}

/**
 * Is one roll internally consistent with its spec — a single `number`d`faces` term, the highest `keep`
 * dice kept (default all), total = kept sum × `multiplier` (default 1)? Returns a problem string or null.
 */
export function checkDiceRoll(roll, { number, faces, keep = number, multiplier = 1, formula } = {}) {
  if ( formula !== undefined && roll?.formula !== formula ) return "formula";
  if ( roll?.dice?.length !== 1 ) return "dice";
  const [die] = roll.dice;
  if ( die.number !== number || die.faces !== faces ) return "dice";
  const values = (die.results ?? []).map(r => r.result);
  if ( values.length !== number || values.some(v => !Number.isInteger(v) || v < 1 || v > faces) ) return "faces";
  const kept = die.results.filter(r => r.active).map(r => r.result);
  if ( !sameMultiset(kept, sorted(values).slice(values.length - keep)) ) return "kept";
  if ( roll.total !== kept.reduce((a, b) => a + b, 0) * multiplier ) return "total";
  return null;
}

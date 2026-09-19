/**
 * Rolled ability scores (D15, A10): rolled in the player's browser with Foundry's dice and posted to chat
 * publicly, flagged with the draft id. The GM's validator reads the message back and checks it with
 * abilities.mjs `checkRollRecord`; the chat side is roll-messages.mjs — tamper-evident, not tamper-proof.
 */

import { makeError } from "../contracts.mjs";
import { ABILITY_ROLL, ROLL_PURPOSE, checkAbilities, checkRollRecord } from "./abilities.mjs";
import { postRolls, readRollRecord, rollMessagesFor } from "./roll-messages.mjs";

export { readRollRecord };

/**
 * Roll the six scores and post them to chat. Refuses if the draft already holds a roll (re-rolling means
 * discarding the draft, A10). The caller stores the result in `draft.abilities.roll`.
 * @param {{ id: string, abilities: object }} draft
 * @returns {Promise<{ messageId: string, results: number[] }>}
 */
export async function rollAbilityScores(draft) {
  if ( draft.abilities?.roll ) throw Object.assign(new Error("Already rolled"), makeError("ROLL_INVALID", { alreadyRolled: true }));
  return postRolls({ draftId: draft.id, purpose: ROLL_PURPOSE.ABILITIES, formula: ABILITY_ROLL.formula, count: ABILITY_ROLL.count,
    flavor: game.i18n.localize("CHARCREATOR.AbilityRoll.Flavor") });
}

/**
 * Full ability check for the GM's validator (PLAN 2.6 wires it in): the scores for their method, and for
 * rolled scores the chat record. Also rejects a draft that rolled and then switched method, even if the
 * player cleared the roll from the draft.
 * @param {object} draft
 * @param {{ userId: string, allowedMethods?: string[] }} options
 * @returns {object[]} makeError() objects
 */
export function checkDraftAbilities(draft, { userId, allowedMethods } = {}) {
  const a = draft.abilities ?? {};
  const errors = checkAbilities(a, { allowedMethods });
  if ( errors.length ) return errors;
  const onRecord = rollMessagesFor(draft.id, userId, ROLL_PURPOSE.ABILITIES);
  if ( a.method !== "rolled" ) {
    return onRecord.length ? [makeError("ROLL_INVALID", { rolledButMethod: a.method, messages: onRecord })] : [];
  }
  const record = readRollRecord(game.messages.get(a.roll.messageId));
  return checkRollRecord(record, { draftId: draft.id, userId, results: a.roll.results,
    others: onRecord.filter(id => id !== a.roll.messageId) });
}

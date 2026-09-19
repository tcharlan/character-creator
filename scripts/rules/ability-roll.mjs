/**
 * Rolled ability scores (D15, A10): rolled in the player's browser with Foundry's dice and posted to chat
 * publicly, flagged with the draft id. The GM's validator reads the message back and checks it with
 * abilities.mjs `checkRollRecord` — tamper-evident, not tamper-proof.
 */

import { MODULE_ID, makeError } from "../contracts.mjs";
import { ABILITY_ROLL, ROLL_FLAG, ROLL_PURPOSE, checkAbilities, checkRollRecord } from "./abilities.mjs";

/**
 * Roll the six scores and post them to chat. Refuses if the draft already holds a roll (re-rolling means
 * discarding the draft, A10). The caller stores the result in `draft.abilities.roll`.
 * @param {{ id: string, abilities: object }} draft
 * @returns {Promise<{ messageId: string, results: number[] }>}
 */
export async function rollAbilityScores(draft) {
  if ( draft.abilities?.roll ) throw Object.assign(new Error("Already rolled"), makeError("ROLL_INVALID", { alreadyRolled: true }));
  const rolls = [];
  for ( let i = 0; i < ABILITY_ROLL.count; i++ ) rolls.push(await new Roll(ABILITY_ROLL.formula).evaluate());
  const results = rolls.map(r => r.total);
  // create() cleans its data in place (the JSONField turns each Roll into a string): pass copies.
  const message = await ChatMessage.implementation.create({
    author: game.user.id,
    speaker: { alias: game.user.name },
    flavor: game.i18n.localize("CHARCREATOR.AbilityRoll.Flavor"),
    rolls: rolls.map(r => r.toJSON()),
    sound: CONFIG.sounds.dice,
    flags: { [MODULE_ID]: { [ROLL_FLAG]: { draftId: draft.id, purpose: ROLL_PURPOSE.ABILITIES } } }
  }, { messageMode: "public" });
  return { messageId: message.id, results };
}

/** A plain copy of a roll message for checkRollRecord, or null. */
export function readRollRecord(message) {
  if ( !message ) return null;
  const whisper = message.whisper ?? [];
  return {
    id: message.id,
    authorId: message.author?.id ?? message._source.author,
    public: !whisper.length && !message.blind,
    flag: message.getFlag(MODULE_ID, ROLL_FLAG) ?? null,
    created: message._stats?.createdTime ?? null,
    modified: message._stats?.modifiedTime ?? null,
    rolls: message.rolls.map(r => ({
      formula: r.formula,
      total: r.total,
      dice: r.dice.map(d => ({ number: d.number, faces: d.faces,
        results: d.results.map(x => ({ result: x.result, active: x.active !== false && !x.discarded })) }))
    }))
  };
}

/** Ids of ability-roll messages for a draft by a user, oldest first. */
export function rollMessagesFor(draftId, userId) {
  return game.messages.contents
    .filter(m => {
      const f = m.getFlag(MODULE_ID, ROLL_FLAG);
      return f?.draftId === draftId && f?.purpose === ROLL_PURPOSE.ABILITIES && (m.author?.id ?? m._source.author) === userId;
    })
    .sort((a, b) => (a._stats?.createdTime ?? 0) - (b._stats?.createdTime ?? 0))
    .map(m => m.id);
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
  const onRecord = rollMessagesFor(draft.id, userId);
  if ( a.method !== "rolled" ) {
    return onRecord.length ? [makeError("ROLL_INVALID", { rolledButMethod: a.method, messages: onRecord })] : [];
  }
  const record = readRollRecord(game.messages.get(a.roll.messageId));
  return checkRollRecord(record, { draftId: draft.id, userId, results: a.roll.results,
    others: onRecord.filter(id => id !== a.roll.messageId) });
}

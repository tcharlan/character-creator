/**
 * Recorded rolls, Foundry side (D15): roll in the player's browser with Foundry's dice, post one public chat
 * message flagged with the draft id, and read messages back for roll-record.mjs `checkRecord`.
 */

import { MODULE_ID } from "../contracts.mjs";
import { ROLL_FLAG } from "./roll-record.mjs";

/**
 * Roll `formula` `count` times and post the rolls in one public message.
 * @param {{ draftId: string, purpose: string, source?: string, formula: string, count?: number, flavor: string }} options
 * @returns {Promise<{ messageId: string, results: number[] }>}
 */
export async function postRolls({ draftId, purpose, source, formula, count = 1, flavor }) {
  const rolls = [];
  for ( let i = 0; i < count; i++ ) rolls.push(await new Roll(formula).evaluate());
  const results = rolls.map(r => r.total);
  const flag = { draftId, purpose, ...(source ? { source } : {}) };
  // create() cleans its data in place (the JSONField turns each Roll into a string): pass copies.
  const message = await ChatMessage.implementation.create({
    author: game.user.id,
    speaker: { alias: game.user.name },
    flavor,
    rolls: rolls.map(r => r.toJSON()),
    sound: CONFIG.sounds.dice,
    flags: { [MODULE_ID]: { [ROLL_FLAG]: flag } }
  }, { messageMode: "public" });
  return { messageId: message.id, results };
}

/** A plain copy of a roll message for checkRecord, or null. */
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

/** Ids of roll messages for a draft by a user with this purpose (and source, if given), oldest first. */
export function rollMessagesFor(draftId, userId, purpose, source) {
  return game.messages.contents
    .filter(m => {
      const f = m.getFlag(MODULE_ID, ROLL_FLAG);
      return f?.draftId === draftId && f?.purpose === purpose && (source === undefined || f?.source === source)
        && (m.author?.id ?? m._source.author) === userId;
    })
    .sort((a, b) => (a._stats?.createdTime ?? 0) - (b._stats?.createdTime ?? 0))
    .map(m => m.id);
}

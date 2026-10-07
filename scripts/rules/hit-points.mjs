/**
 * Rolled hit points (D33): with the GM's method set to "rolled", each class level past the first class's first
 * is a roll of that class's hit die, made in the player's browser as soon as the level is part of the character
 * and posted to chat like the scores (D15). Each roll is kept by the class level it is for (`<identifier>@<level>`),
 * so changing the level split and changing it back finds the same dice: one roll per slot per draft. The GM's
 * side reads the messages back and checks every roll the character uses.
 */

import { MODULE_ID, makeError } from "../contracts.mjs";
import { ROLL_FLAG, ROLL_PURPOSE, EDIT_TOLERANCE_MS, checkDiceRoll } from "./roll-record.mjs";
import { readRollRecord, rollMessagesFor } from "./roll-messages.mjs";

/** The hit dice a build is waiting on: `[{ slot, faces }]`, in the order the replay met them. */
export function slotsToRoll(build) {
  const seen = new Set();
  const out = [];
  for ( const r of build?.results ?? [] ) {
    if ( (r.type !== "HitPoints") || (r.status !== "needsInput") ) continue;
    const { slot, faces } = r;
    if ( !slot || !faces || seen.has(slot) ) continue;
    seen.add(slot);
    out.push({ slot, faces });
  }
  return out;
}

/**
 * Roll the hit dice for slots that have none yet, in one public message. Slots already rolled are never rolled
 * again. Returns the new entries for `draft.hitPoints.rolls`.
 * @param {{ id: string, hitPoints?: object }} draft
 * @param {{ slot: string, faces: number }[]} needs
 * @returns {Promise<Record<string, { faces, total, messageId }>>}
 */
export async function rollHitPoints(draft, needs) {
  const fresh = needs.filter(n => !draft.hitPoints?.rolls?.[n.slot]);
  if ( !fresh.length ) return {};
  const rolls = [];
  for ( const n of fresh ) rolls.push(await new Roll(`1d${n.faces}`).evaluate());
  const message = await ChatMessage.implementation.create({
    author: game.user.id,
    speaker: { alias: game.user.name },
    flavor: game.i18n.localize("CHARCREATOR.HitPointRoll.Flavor"),
    rolls: rolls.map(r => r.toJSON()),
    sound: CONFIG.sounds.dice,
    // A random character's hit dice belong to its go (D31, D33): a reroll rolls them again, in a new go.
    flags: { [MODULE_ID]: { [ROLL_FLAG]: { draftId: draft.id, purpose: ROLL_PURPOSE.HIT_POINTS, slots: fresh.map(n => n.slot),
      ...(draft.random?.attempt ? { attempt: draft.random.attempt } : {}) } } }
  }, { messageMode: "public" });
  return Object.fromEntries(fresh.map((n, i) => [n.slot, { faces: n.faces, total: rolls[i].total, messageId: message.id }]));
}

/**
 * Check the rolled hit dice a character uses against chat (pure: the records come from `readRollRecord`).
 * @param {object} draft
 * @param {object[]} records          Every hit point roll message for this draft by its owner.
 * @param {{ userId: string, used: string[] }} options   `used`: the slots the built character takes a roll for.
 * @returns {object[]} makeError() objects (HIT_POINTS_ROLL_INVALID)
 */
export function checkHitPointRecords(draft, records, { userId, used = [] }) {
  const fail = detail => [makeError("HIT_POINTS_ROLL_INVALID", detail)];
  // A slot rolled in more than one message was rolled again: the first roll is the one that counts (D33).
  const bySlot = new Map();
  // Only this go's rolls, for a random character rolled again (D31).
  const attempt = draft.mode === "hardcore" ? (draft.random?.attempt ?? 1) : null;
  for ( const record of records.filter(r => (attempt === null) || ((r?.flag?.attempt ?? 1) === attempt)) ) {
    for ( const slot of record?.flag?.slots ?? [] ) bySlot.set(slot, [...(bySlot.get(slot) ?? []), record]);
  }
  for ( const slot of used ) {
    const roll = draft.hitPoints?.rolls?.[slot];
    if ( !roll ) return fail({ slot, message: "missing" });
    const posted = bySlot.get(slot) ?? [];
    if ( posted.length > 1 ) return fail({ slot, message: "rerolled" });
    const record = posted[0];
    if ( !record || (record.id !== roll.messageId) ) return fail({ slot, message: "noMessage" });
    if ( record.authorId !== userId ) return fail({ slot, message: "wrongAuthor" });
    if ( (record.flag?.draftId !== draft.id) || (record.flag?.purpose !== ROLL_PURPOSE.HIT_POINTS) ) return fail({ slot, message: "wrongDraft" });
    if ( !record.public ) return fail({ slot, message: "notPublic" });
    if ( !(Math.abs((record.modified ?? NaN) - (record.created ?? NaN)) <= EDIT_TOLERANCE_MS) ) return fail({ slot, message: "edited" });
    const die = record.rolls?.[record.flag.slots.indexOf(slot)];
    const problem = checkDiceRoll(die, { number: 1, faces: roll.faces });
    if ( problem ) return fail({ slot, message: "badRoll", problem });
    if ( die.total !== roll.total ) return fail({ slot, message: "resultsDiffer", recorded: die.total, draft: roll.total });
  }
  return [];
}

/** The slots a built character takes a rolled hit die for. */
export function usedSlots(build) {
  return (build?.results ?? []).filter(r => (r.type === "HitPoints") && Number.isInteger(r.data?.[r.level]) && r.slot)
    .map(r => r.slot);
}

/** The GM's (and the wizard's) check of a draft's rolled hit dice, from this world's chat. */
export function checkDraftHitPoints(draft, built, { userId }) {
  const records = rollMessagesFor(draft.id, userId, ROLL_PURPOSE.HIT_POINTS).map(id => readRollRecord(game.messages.get(id)));
  return checkHitPointRecords(draft, records, { userId, used: usedSlots(built) });
}

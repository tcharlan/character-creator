/**
 * Checking a random character (D31), on the GM's side. The player's browser rolled the dice and posted them;
 * here the same loop runs again with those recorded totals and the result is compared with what was submitted.
 * A character that doesn't match its own rolls is refused.
 *
 * Tamper-evident, not tamper-proof, like the other recorded rolls (roll-record.mjs): it catches an edited
 * draft, an edited or borrowed message and re-rolls, not a modified client.
 */

import { ABILITIES, makeError } from "../contracts.mjs";
import { rollCharacter, ROLLED_DETAILS } from "./random.mjs";

/** The parts the loop rolls, and what each one settles in the draft. */
const PARTS = Object.freeze(["species", "class", "background", "abilities", "choices", "equipment", "details"]);
const PERSONALITY_FIELDS = ROLLED_DETAILS.filter(f => f !== "alignment");

const fail = detail => [makeError("RANDOM_INVALID", detail)];

/** The rolls a message holds, as `{ faces, total }`, or null when it isn't one die per roll. */
export function messageRolls(record) {
  const out = [];
  for ( const roll of record?.rolls ?? [] ) {
    const dice = roll.dice ?? [];
    if ( (dice.length !== 1) || (dice[0].number !== 1) ) return null;
    out.push({ faces: dice[0].faces, total: roll.total });
  }
  return out;
}

/**
 * The draft as it was before the dice: the parts the GM leaves to the player are kept, the rolled ones cleared,
 * so the replay has to produce them again.
 */
export function clearRolled(draft, free = []) {
  const rolled = part => !free.includes(part);
  const next = structuredClone(draft);
  for ( const role of ["species", "class", "background"] ) if ( rolled(role) ) next.picks[role] = null;
  if ( rolled("choices") ) next.recipe = { steps: [] };
  else if ( rolled("species") || rolled("class") || rolled("background") ) {
    // The rolled picks decide which steps exist at all; answers under a rolled pick go with it.
    next.recipe = { steps: (next.recipe.steps ?? []).filter(s => !rolled(s.path?.[0])) };
  }
  if ( rolled("equipment") ) next.equipment = { class: null, background: null };
  if ( rolled("details") ) {
    next.details = { ...next.details, alignment: "" };
    for ( const field of PERSONALITY_FIELDS ) next.details[field] = "";
  }
  return next;
}

/** What the replay has to match, part by part. */
function comparable(draft, free = []) {
  const rolled = part => !free.includes(part);
  const out = {};
  for ( const role of ["species", "class", "background"] ) if ( rolled(role) ) out[role] = draft.picks[role] ?? null;
  if ( rolled("choices") ) {
    out.steps = [...(draft.recipe.steps ?? [])]
      .map(s => ({ path: [...s.path], advancementId: s.advancementId, level: s.level, data: s.data }))
      .sort((a, b) => `${a.path.join(">")}:${a.advancementId}:${a.level}`
        .localeCompare(`${b.path.join(">")}:${b.advancementId}:${b.level}`));
  }
  if ( rolled("equipment") ) {
    out.equipment = Object.fromEntries(["class", "background"].map(role => {
      const selection = draft.equipment[role];
      // The wealth roll has a record of its own (checked with the equipment); only the choice of gold matters here.
      return [role, selection ? { mode: selection.mode, choices: selection.choices ?? {}, picks: selection.picks ?? {} } : null];
    }));
  }
  if ( rolled("details") ) {
    out.details = Object.fromEntries(["alignment", ...PERSONALITY_FIELDS].map(f => [f, draft.details[f] ?? ""]));
  }
  return out;
}

/** The first part whose replay differs from the draft, or null. */
function firstDifference(expected, actual) {
  for ( const key of Object.keys(expected) ) {
    if ( JSON.stringify(expected[key]) !== JSON.stringify(actual[key]) ) return key;
  }
  return null;
}

/**
 * Check a submitted random character.
 * @param {object} draft                      A migrated, well-formed draft with `mode: "hardcore"`.
 * @param {object} options
 * @param {object|null} options.record         The roll message, from readRollRecord().
 * @param {string} options.userId              The draft's owner.
 * @param {string[]} [options.free]            The parts the GM leaves to the player.
 * @param {string[]} [options.otherMessages]   Other random-roll messages for this draft (re-rolls).
 * @param {object} options.replay              The callbacks rollCharacter() needs (catalog, rebuild, …), plus
 *   `finish`: the creator writes the automatic steps into the draft as well, so the replay is finished the
 *   same way before the two are compared.
 * @returns {Promise<object[]>} makeError() objects
 */
export async function checkRandomDraft(draft, { record, userId, free = [], otherMessages = [], replay } = {}) {
  const random = draft.random;
  if ( !random ) return fail({ message: "missing" });
  if ( !record ) return fail({ message: "noMessage" });
  if ( record.id !== random.messageId ) return fail({ message: "wrongMessage" });
  if ( record.authorId !== userId ) return fail({ message: "wrongAuthor" });
  if ( record.flag?.draftId !== draft.id ) return fail({ message: "wrongDraft" });
  if ( !record.public ) return fail({ message: "notPublic" });
  if ( !(Math.abs((record.modified ?? NaN) - (record.created ?? NaN)) <= 1000) ) return fail({ message: "edited" });
  if ( otherMessages.length ) return fail({ message: "rerolled", others: [...otherMessages] });

  const posted = messageRolls(record);
  if ( !posted ) return fail({ message: "notSingleDice" });
  if ( posted.length !== random.rolls.length ) {
    return fail({ message: "rollCount", posted: posted.length, draft: random.rolls.length });
  }
  for ( const [i, roll] of random.rolls.entries() ) {
    if ( (posted[i].faces !== roll.faces) || (posted[i].total !== roll.total) ) {
      return fail({ message: "rollsDiffer", roll: i, posted: posted[i], draft: { faces: roll.faces, total: roll.total } });
    }
  }

  // The scores are the six the player rolled, in the order they fell (D31; the roll itself is checked with
  // the other ability rolls).
  if ( !free.includes("abilities") ) {
    const results = draft.abilities?.roll?.results ?? [];
    const inOrder = ABILITIES.every((key, i) => (draft.abilities?.base?.[key] ?? null) === (results[i] ?? null));
    if ( (draft.abilities?.method !== "rolled") || !inOrder ) return fail({ message: "scoresNotAsRolled" });
  }

  // Replay: the same loop, the same totals — it must make the same character.
  const queue = [...random.rolls];
  const used = [];
  const roll = async (faces, key) => {
    const next = queue.shift();
    if ( !next ) throw Object.assign(new Error("out of rolls"), { detail: { message: "tooFewRolls", key } });
    if ( (next.key !== key) || (next.faces !== faces) ) {
      throw Object.assign(new Error("wrong roll"), { detail: { message: "rollsOutOfOrder", expected: { key, faces },
        recorded: { key: next.key, faces: next.faces } } });
    }
    used.push(next);
    return next.total;
  };
  let replayed;
  try {
    replayed = await rollCharacter({ ...replay, draft: clearRolled(draft, free), free, roll });
    replayed = (await replay?.finish?.(replayed)) ?? replayed;
  } catch ( err ) {
    return fail(err.detail ?? { message: "replayFailed", error: String(err?.message ?? err) });
  }
  if ( queue.length ) return fail({ message: "tooManyRolls", left: queue.length });

  const difference = firstDifference(comparable(draft, free), comparable(replayed, free));
  if ( difference ) return fail({ message: "doesNotMatch", part: PARTS.includes(difference) ? difference : "choices" });
  return [];
}

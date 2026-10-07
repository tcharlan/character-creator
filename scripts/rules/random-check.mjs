/**
 * Checking a random character (D31), on the GM's side. The player's browser rolled the dice and posted them;
 * here the same loop runs again with those recorded totals and the result is compared with what was submitted.
 * A character that doesn't match its own rolls is refused.
 *
 * Tamper-evident, not tamper-proof, like the other recorded rolls (roll-record.mjs): it catches an edited
 * draft, an edited or borrowed message and re-rolls, not a modified client.
 */

import { ABILITIES, makeError } from "../contracts.mjs";
import { rollCharacter, ROLLED_DETAILS, playerOwned } from "./random.mjs";
import { stepKey } from "./paths.mjs";

/** The parts the loop rolls, and what each one settles in the draft. */
const PARTS = Object.freeze(["species", "class", "background", "abilities", "choices", "equipment", "details", "stages"]);
const PERSONALITY_FIELDS = ROLLED_DETAILS.filter(f => f !== "alignment");

const fail = detail => [makeError("RANDOM_INVALID", detail)];
/** Rolling more often than the GM allows is its own refusal: the character is sound, the player took more goes. */
const attemptsFail = detail => [makeError("RANDOM_ATTEMPTS", detail)];

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
export function clearRolled(draft, free = [], { abilities = false } = {}) {
  const rolled = part => !free.includes(part);
  const next = structuredClone(draft);
  // Only a reroll asks for this: the GM's replay keeps the scores, which it checks against their own record.
  if ( abilities && rolled("abilities") ) next.abilities = { method: null, base: null, roll: null };
  for ( const role of ["species", "class", "background"] ) if ( rolled(role) ) next.picks[role] = null;
  // The player's own answers stay: a pick from a shortlist (D35, D36, D39) and the choices inside a feat taken at
  // one. The shortlists themselves are dropped and rolled again, so each pick can be held to its list.
  const stages = draft.random?.stages ?? {};
  const owned = s => playerOwned({ key: stepKey(s), path: s.path }, stages);
  if ( rolled("choices") ) next.recipe = { steps: (next.recipe.steps ?? []).filter(owned) };
  else if ( rolled("species") || rolled("class") || rolled("background") ) {
    // The rolled picks decide which steps exist at all; answers under a rolled pick go with it.
    next.recipe = { steps: (next.recipe.steps ?? []).filter(s => !rolled(s.path?.[0]) || owned(s)) };
  }
  if ( next.random?.stages ) {
    next.random = { ...next.random, stages: Object.fromEntries(Object.entries(next.random.stages)
      .map(([key, s]) => { const { options, ...rest } = s; void options; return [key, rest]; })) };
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
  // Every shortlist, as the dice made it.
  out.stages = Object.fromEntries(Object.entries(draft.random?.stages ?? {}).map(([key, s]) => [key, s.options ?? null])
    .sort(([a], [b]) => a.localeCompare(b)));
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
 * @param {object[]} options.records           The roll messages, in the order they were posted
 *   (readRollRecord()). A character is rolled in more than one go when a choice the player was left opens
 *   decisions the first dice never saw.
 * @param {string} options.userId              The draft's owner.
 * @param {string[]} [options.free]            The parts the GM leaves to the player.
 * @param {number} [options.attempts]          How many goes at a rolled character the GM allows (0 = any
 *   number). A reroll starts a fresh series of messages, numbered in each message's flag, so the count of
 *   goes on record is checked here too — that is what makes the limit worth anything.
 * @param {object} options.replay              The callbacks rollCharacter() needs (catalog, rebuild, …), plus
 *   `finish`: the creator writes the automatic steps into the draft as well, so the replay is finished the
 *   same way before the two are compared.
 * @returns {Promise<object[]>} makeError() objects
 */
export async function checkRandomDraft(draft, { records = [], userId, free = [], attempts = 1, replay } = {}) {
  const random = draft.random;
  if ( !random ) return fail({ message: "missing" });
  if ( !records.length ) return fail({ message: "noMessage" });

  // Each go at the character is numbered (D31). Earlier goes stay in chat, so they are counted here and then
  // set aside: only the go this character came from is checked against the draft.
  const attemptOf = record => record.flag?.attempt ?? 1;
  const goes = new Set(records.map(attemptOf));
  if ( (attempts > 0) && (goes.size > attempts) ) {
    return attemptsFail({ message: "tooManyAttempts", used: goes.size, allowed: attempts });
  }
  const mineAttempt = random.attempt ?? 1;
  const latest = Math.max(...goes);
  if ( mineAttempt !== latest ) {
    // An earlier character kept while the dice were rolled again: that is cherry-picking the best of them.
    return attemptsFail({ message: "staleAttempt", draft: mineAttempt, posted: latest });
  }
  const mine = records.filter(r => attemptOf(r) === mineAttempt);

  // Every message the draft names, in its order, and nothing else: no borrowed or extra rolls.
  if ( mine.length !== random.messageIds.length ) {
    return fail({ message: "messageCount", posted: mine.length, draft: random.messageIds.length });
  }
  const posted = [];
  for ( const [i, record] of mine.entries() ) {
    if ( record.id !== random.messageIds[i] ) return fail({ message: "wrongMessage" });
    if ( record.authorId !== userId ) return fail({ message: "wrongAuthor" });
    if ( record.flag?.draftId !== draft.id ) return fail({ message: "wrongDraft" });
    if ( !record.public ) return fail({ message: "notPublic" });
    if ( !(Math.abs((record.modified ?? NaN) - (record.created ?? NaN)) <= 1000) ) return fail({ message: "edited" });
    const rolls = messageRolls(record);
    if ( !rolls ) return fail({ message: "notSingleDice" });
    posted.push(...rolls);
  }
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
  //
  // Each roll is taken by **what it was for**, not by its place in the line. The player's own choices can be
  // made at any time, so a decision that depended on one (the class's equipment) may have been rolled after
  // it rather than with the first handful; the decision's key is the same either way.
  const left = new Map();
  for ( const entry of random.rolls ) {
    if ( !left.has(entry.key) ) left.set(entry.key, []);
    left.get(entry.key).push(entry);
  }
  const roll = async (faces, key) => {
    const forKey = left.get(key) ?? [];
    const next = forKey.shift();
    if ( !next ) throw Object.assign(new Error("out of rolls"), { detail: { message: "tooFewRolls", key } });
    if ( next.faces !== faces ) {
      throw Object.assign(new Error("wrong roll"), { detail: { message: "wrongDie", key,
        expected: faces, recorded: next.faces } });
    }
    return next.total;
  };
  let replayed;
  try {
    replayed = await rollCharacter({ ...replay, draft: clearRolled(draft, free), free, roll });
    replayed = (await replay?.finish?.(replayed)) ?? replayed;
  } catch ( err ) {
    return fail(err.detail ?? { message: "replayFailed", error: String(err?.message ?? err) });
  }
  const unused = [...left.values()].flat();
  if ( unused.length ) return fail({ message: "tooManyRolls", left: unused.length, first: unused[0]?.key,
    keys: unused.slice(0, 8).map(u => u.key) });

  const difference = firstDifference(comparable(draft, free), comparable(replayed, free));
  if ( difference ) return fail({ message: "doesNotMatch", part: PARTS.includes(difference) ? difference : "choices" });
  return checkStagePicks(draft);
}

/**
 * Each pick the player made at a stage is one the dice offered (D35, D36, D39): the classes taken, the subclass,
 * the feat (or the increase, which is always on offer at a feat slot).
 * @returns {object[]} makeError() objects
 */
export function checkStagePicks(draft) {
  const stages = draft.random?.stages ?? {};
  const offered = key => new Set(stages[key]?.options ?? []);
  if ( stages.multiclass && !stages.multiclass.answered ) return fail({ message: "notAnswered", stage: "multiclass" });
  if ( (draft.multiclass ?? []).length ) {
    const list = offered("multiclass");
    const other = draft.multiclass.find(m => !list.has(m.uuid));
    if ( !stages.multiclass || other ) return fail({ message: "notOffered", stage: "multiclass", uuid: other?.uuid ?? null });
  }
  for ( const step of draft.recipe?.steps ?? [] ) {
    const key = stepKey(step);
    const stage = stages[key];
    if ( !stage ) continue;
    const pick = stage.kind === "subclass" ? step.data?.uuid : (step.data?.type === "feat" ? step.data.uuid : null);
    if ( (pick !== null) && (pick !== undefined) && !offered(key).has(pick) ) {
      return fail({ message: "notOffered", stage: stage.kind, uuid: pick });
    }
  }
  return [];
}

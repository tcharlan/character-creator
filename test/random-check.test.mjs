import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRandomDraft, clearRolled, messageRolls } from "../scripts/rules/random-check.mjs";
import { createDraft, ABILITIES } from "../scripts/contracts.mjs";

/*
 * The GM's check of a random character (D31): the rolls must be the ones in chat, and replaying them against
 * this world's content must make the character that was submitted.
 */

const ID = n => String(n).padEnd(16, "0");
const U = (pack, n) => `Compendium.test.${pack}.Item.${ID(n)}`;
const CATALOG = {
  byCategory: {
    species: [{ uuid: U("species", "elf") }, { uuid: U("species", "dwarf") }],
    class: [{ uuid: U("classes", "wizard") }, { uuid: U("classes", "cleric") }],
    background: [{ uuid: U("backgrounds", "acolyte") }]
  }
};
const ROLLS = [{ key: "species", faces: 2, total: 2 }, { key: "class", faces: 2, total: 1 },
  { key: "background", faces: 1, total: 1 }, { key: "details:alignment", faces: 2, total: 2 }];
const ALIGNMENTS = ["Lawful Good", "Chaotic Evil"];
const MESSAGE_ID = ID("msg");
const USER = ID("user");

const record = (over = {}) => ({
  id: MESSAGE_ID, authorId: USER, public: true, flag: { draftId: ID("d"), purpose: "random" },
  created: 1000, modified: 1000,
  rolls: ROLLS.map(r => ({ formula: `1d${r.faces}`, total: r.total,
    dice: [{ number: 1, faces: r.faces, results: [{ result: r.total, active: true }] }] })),
  ...over
});

const replay = {
  catalog: CATALOG,
  rebuild: async () => ({ results: [], roots: {}, actor: null }),
  equipmentContext: async () => null,
  alignments: ALIGNMENTS
};

/** The character those rolls make: the second species, the first class, the only background, evil. */
function submitted(over = {}) {
  const draft = createDraft({ id: ID("d"), worldId: "w", rules: "legacy", now: 1 });
  draft.mode = "hardcore";
  draft.random = { messageIds: [MESSAGE_ID], rolls: ROLLS.map(r => ({ ...r })) };
  draft.picks = { species: U("species", "elf"), class: U("classes", "cleric"), background: U("backgrounds", "acolyte") };
  draft.abilities = { method: "rolled", base: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
    roll: { messageId: ID("abil"), results: [15, 14, 13, 12, 10, 8] } };
  draft.details.alignment = "Chaotic Evil";
  return { ...draft, ...over };
}

const check = (draft, over = {}) => checkRandomDraft(draft, { records: [record()], userId: USER, replay, ...over });

test("a character that matches its rolls passes", async () => {
  assert.deepEqual(await check(submitted()), []);
});

test("the dice have to be the ones in chat, posted by the player, unedited and only once", async () => {
  const reason = async over => (await check(submitted(), over))[0]?.detail?.message;
  assert.equal(await reason({ records: [] }), "noMessage");
  assert.equal(await reason({ userId: ID("other") }), "wrongAuthor");
  assert.equal(await reason({ records: [record({ public: false })] }), "notPublic");
  assert.equal(await reason({ records: [record({ modified: 9999 })] }), "edited");
  assert.equal(await reason({ records: [record(), record({ id: ID("another") })] }), "messageCount",
    "a message the draft doesn't name is a roll from somewhere else");
  assert.equal(await reason({ records: [record({ id: ID("elsewhere") })] }), "wrongMessage");
  assert.equal(await reason({ records: [record({ flag: { draftId: ID("x"), purpose: "random" } })] }), "wrongDraft");
});

test("the totals in the draft have to be the totals that were rolled", async () => {
  const draft = submitted();
  draft.random.rolls[0] = { ...draft.random.rolls[0], total: 1 };
  const [error] = await check(draft);
  assert.equal(error.detail.message, "rollsDiffer");
  const short = submitted();
  short.random.rolls = short.random.rolls.slice(0, 2);
  assert.equal((await check(short))[0].detail.message, "rollCount");
});

test("a character that doesn't match the replay is refused, and says which part", async () => {
  const swapped = submitted();
  swapped.picks.species = U("species", "dwarf");   // the die said the other one
  const [error] = await check(swapped);
  assert.equal(error.code, "RANDOM_INVALID");
  assert.equal(error.detail.message, "doesNotMatch");
  assert.equal(error.detail.part, "species");

  const alignment = submitted();
  alignment.details.alignment = "Lawful Good";
  assert.equal((await check(alignment))[0].detail.part, "details");
});

test("the six scores must be the ones rolled, in the order they fell", async () => {
  const arranged = submitted();
  arranged.abilities.base = { str: 8, dex: 15, con: 14, int: 13, wis: 12, cha: 10 };
  assert.equal((await check(arranged))[0].detail.message, "scoresNotAsRolled");
  // Unless the GM leaves the scores to the player.
  assert.deepEqual(await check(arranged, { free: ["abilities"] }), []);
  assert.deepEqual(ABILITIES.length, 6);
});

test("the parts the GM leaves to the player are not replayed", async () => {
  // The player chose their class, so the class die was never rolled and the pick isn't checked.
  const free = ["class"];
  const draft = submitted();
  draft.picks.class = U("classes", "wizard");
  draft.random.rolls = ROLLS.filter(r => r.key !== "class").map(r => ({ ...r }));
  const message = record({ rolls: draft.random.rolls.map(r => ({ formula: `1d${r.faces}`, total: r.total,
    dice: [{ number: 1, faces: r.faces, results: [{ result: r.total, active: true }] }] })) });
  assert.deepEqual(await check(draft, { free, records: [message] }), []);
});

test("rolls posted later, in another message, still count for the decision they were for", async () => {
  // The player's own choice opened more to roll, so the dice came in two goes and in an order the replay
  // doesn't ask for: each roll is taken by what it was for, not by its place in the line.
  const draft = submitted();
  const [species, klass, background, alignment] = ROLLS;
  draft.random = { messageIds: [MESSAGE_ID, ID("later")],
    rolls: [alignment, background, species, klass].map(r => ({ ...r })) };
  const dice = rolls => rolls.map(r => ({ formula: `1d${r.faces}`, total: r.total,
    dice: [{ number: 1, faces: r.faces, results: [{ result: r.total, active: true }] }] }));
  const records = [record({ rolls: dice([alignment, background]) }),
    record({ id: ID("later"), rolls: dice([species, klass]) })];
  assert.deepEqual(await check(draft, { records }), []);

  // A die of the wrong size for that decision is still caught.
  const wrong = submitted();
  wrong.random = { messageIds: [MESSAGE_ID], rolls: ROLLS.map(r => (r.key === "species" ? { ...r, faces: 3 } : { ...r })) };
  const [error] = await check(wrong, { records: [record({ rolls: dice(wrong.random.rolls) })] });
  assert.equal(error.detail.message, "wrongDie");
  assert.equal(error.detail.key, "species");
});

test("clearRolled keeps what the player owns and empties what the dice decided", () => {
  const draft = submitted();
  draft.details.name = "Kept";
  draft.spells.cantrips = [U("spells", "firebolt")];
  const cleared = clearRolled(draft, ["class"]);
  assert.equal(cleared.picks.species, null, "rolled");
  assert.equal(cleared.picks.class, U("classes", "cleric"), "the player's");
  assert.equal(cleared.details.alignment, "");
  assert.equal(cleared.details.name, "Kept");
  assert.deepEqual(cleared.spells.cantrips, draft.spells.cantrips);
});

test("only one die per roll is accepted in the message", () => {
  assert.deepEqual(messageRolls(record()).length, 4);
  assert.equal(messageRolls({ rolls: [{ total: 7, dice: [{ number: 2, faces: 6, results: [] }] }] }), null);
  assert.equal(messageRolls({ rolls: [{ total: 7, dice: [] }] }), null);
});

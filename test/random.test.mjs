import { test } from "node:test";
import assert from "node:assert/strict";
import { rollCharacter, at } from "../scripts/rules/random.mjs";
import { createDraft } from "../scripts/contracts.mjs";

/*
 * The random character (D31). The loop is the same on both sides — the player's dice make it, the GM's copy
 * replays it from the recorded totals — so these tests check what it decides for a given set of totals, that
 * it leaves the parts the GM freed alone, and that the same totals always make the same character.
 */

const ID = n => String(n).padEnd(16, "0");
const U = (pack, n) => `Compendium.test.${pack}.Item.${ID(n)}`;
const CATALOG = {
  byCategory: {
    species: [{ uuid: U("species", "elf") }, { uuid: U("species", "dwarf") }, { uuid: U("species", "human") }],
    class: [{ uuid: U("classes", "wizard") }, { uuid: U("classes", "cleric") }],
    background: [{ uuid: U("backgrounds", "acolyte") }]
  }
};

/** A replay with one open skill choice, which closes once the recipe answers it. */
const traitResult = {
  key: "class>skills", path: ["class"], advancementId: ID("adv"), level: 1, item: "Wizard", title: "Skills",
  type: "Trait", status: "needsInput", data: null,
  options: { type: "Trait", allowed: ["skills:arc", "skills:his", "skills:inv"], grants: [], max: 2 }
};

/** Runs the loop with scripted dice; returns the draft and what was rolled. */
async function run({ free = [], totals = [], results = [traitResult] } = {}) {
  const draft = createDraft({ id: ID("d"), worldId: "w", rules: "legacy", now: 1 });
  const rolled = [];
  const queue = [...totals];
  const roll = async (faces, key) => {
    const total = queue.length ? queue.shift() : 1;
    rolled.push({ key, faces, total });
    return total;
  };
  let answered = false;
  await rollCharacter({
    draft, catalog: CATALOG, free, roll,
    rebuild: async d => {
      answered = (d.recipe.steps ?? []).length > 0;
      return { results: answered ? [{ ...traitResult, status: "done" }] : results, roots: {}, actor: null };
    },
    equipmentContext: async () => null,
    alignments: ["Lawful Good", "True Neutral", "Chaotic Evil"]
  });
  return { draft, rolled };
}

test("the dice pick species, class and background from what the GM allows", async () => {
  const { draft, rolled } = await run({ totals: [2, 2, 1, 1, 1, 1] });
  assert.equal(draft.picks.species, U("species", "elf"), "sorted by UUID, so both sides agree");
  assert.equal(draft.picks.class, U("classes", "wizard"));
  assert.equal(draft.picks.background, U("backgrounds", "acolyte"));
  assert.deepEqual(rolled.slice(0, 3).map(r => [r.key, r.faces]), [["species", 3], ["class", 2], ["background", 1]]);
});

test("an open choice is answered, one die per pick, and written to the recipe", async () => {
  const { draft, rolled } = await run({ totals: [1, 1, 1, 2, 1] });
  const step = draft.recipe.steps.find(s => s.advancementId === ID("adv"));
  assert.ok(step, "the choice reached the recipe");
  assert.equal(step.data.chosen.length, 2, "both picks");
  assert.deepEqual(step.data.chosen, ["skills:his", "skills:arc"], "the second die picks from what is left");
  const dice = rolled.filter(r => r.key.startsWith("choice:"));
  assert.deepEqual(dice.map(r => r.faces), [3, 2], "three to choose from, then two");
});

test("the parts the GM leaves to the player are not rolled", async () => {
  const { draft, rolled } = await run({ free: ["class", "choices", "details"], totals: [1, 1, 1, 1] });
  assert.equal(draft.picks.class, null, "the player chooses their class");
  assert.ok(draft.picks.species, "the rest is still rolled");
  assert.equal(rolled.some(r => r.key === "class"), false);
  assert.equal(rolled.some(r => r.key.startsWith("choice:")), false);
  assert.equal(draft.details.alignment, "", "and their alignment");
});

test("alignment is rolled when details are not the player's", async () => {
  const { draft, rolled } = await run({ totals: [1, 1, 1, 1, 1, 3] });
  assert.equal(draft.details.alignment, "Chaotic Evil");
  assert.deepEqual(rolled.at(-1), { key: "details:alignment", faces: 3, total: 3 });
});

test("the same totals always make the same character", async () => {
  const totals = [3, 2, 1, 2, 1, 2];
  const first = await run({ totals: [...totals] });
  const second = await run({ totals: [...totals] });
  assert.deepEqual(second.draft.picks, first.draft.picks);
  assert.deepEqual(second.draft.recipe.steps, first.draft.recipe.steps);
  assert.deepEqual(second.draft.details, first.draft.details);
  assert.deepEqual(second.rolled, first.rolled, "and asks for the same dice, in the same order");
});

test("a die result outside the list still lands on a real option", () => {
  assert.equal(at(["a", "b", "c"], 1), "a");
  assert.equal(at(["a", "b", "c"], 3), "c");
  assert.equal(at(["a", "b", "c"], 9), "c");
  assert.equal(at(["a", "b", "c"], 0), "a");
});

test("the gear is taken, never the bag of gold, and each either/or is rolled", async () => {
  // One source, offering gold as well as gear, with an "a or b" and one "any simple weapon" slot.
  const tree = { nodes: new Map() };
  const context = {
    tree,
    wealth: "5d4 * 10",
    wealthOption: { number: 5, faces: 4, multiplier: 10 },
    candidates: () => [],
    isProficient: () => true
  };
  const draft = createDraft({ id: ID("d"), worldId: "w", rules: "legacy", now: 1 });
  const rolled = [];
  const roll = async (faces, key) => {
    rolled.push({ key, faces });
    return 1;
  };
  await rollCharacter({
    draft, catalog: CATALOG, free: ["species", "class", "background", "abilities", "choices", "details"], roll,
    rebuild: async () => ({ results: [], roots: { class: "id" }, actor: null }),
    equipmentContext: async role => (role === "class" ? context : null)
  });
  assert.equal(draft.equipment.class.mode, "items", "the gear, as an ordinary character takes it");
  assert.equal(rolled.some(r => r.key.endsWith(":mode")), false, "no die decides gold over gear");
});

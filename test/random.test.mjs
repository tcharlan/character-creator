import { test } from "node:test";
import assert from "node:assert/strict";
import { rollCharacter, at } from "../scripts/rules/random.mjs";
import { createDraft } from "../scripts/contracts.mjs";
import { buildTree } from "../scripts/rules/equipment.mjs";

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

test("run again after the player's own choice, and only what it opened is rolled", async () => {
  // The GM leaves the class to the player: the first run has no class to bring choices with it, so the
  // character comes out of it unfinished. Picking one opens a skill choice that the dice have to settle.
  const draft = createDraft({ id: ID("d"), worldId: "w", rules: "legacy", now: 1 });
  const rolled = [];
  const roll = async (faces, key) => {
    rolled.push({ key, faces, total: 1 });
    return 1;
  };
  const loop = () => rollCharacter({
    draft, catalog: CATALOG, free: ["class"], roll,
    // Only a class has advancements to answer, and only until the recipe answers them.
    rebuild: async d => ({ roots: {}, actor: null,
      results: (d.picks.class && !(d.recipe.steps ?? []).length) ? [traitResult] : [] }),
    equipmentContext: async () => null,
    alignments: ["Lawful Good"]
  });

  await loop();
  const first = rolled.map(r => r.key);
  assert.equal(draft.picks.class, null, "the player's to make");
  assert.deepEqual(first, ["species", "background", "details:alignment"], "nothing else was open");

  draft.picks.class = U("classes", "wizard");
  await loop();
  assert.deepEqual(rolled.map(r => r.key).slice(first.length), ["choice:class>skills:0", "choice:class>skills:1"],
    "the choice the class brought with it, and nothing that was already decided");
  assert.equal(draft.picks.species, U("species", "dwarf"), "the first run's picks stand");
  assert.equal(draft.details.alignment, "Lawful Good");
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

test("an either/or never lands on gear the character isn't proficient with", async () => {
  // "(a) a mace or (b) a warhammer (if proficient)": the die would take the warhammer (the last option).
  const e = (_id, type, group, extra = {}) => ({ _id: ID(_id), type, group: group ? ID(group) : null, sort: 0, count: 1, ...extra });
  const tree = buildTree([e("or1", "OR", null), e("a1", "linked", "or1", { key: U("items", "mace"), sort: 1 }),
    e("a2", "linked", "or1", { key: U("items", "warhammer"), sort: 2, requiresProficiency: true })]);
  const run = async proficient => {
    const draft = createDraft({ id: ID("d"), worldId: "w", rules: "legacy", now: 1 });
    await rollCharacter({
      draft, catalog: CATALOG, free: ["species", "class", "background", "abilities", "choices", "details"],
      roll: async faces => faces,
      rebuild: async () => ({ results: [], roots: { class: "id" }, actor: null }),
      equipmentContext: async role => (role === "class"
        ? { tree, wealthOption: null, candidates: () => [], isProficient: () => proficient } : null)
    });
    return draft.equipment.class.choices[ID("or1")];
  };
  assert.equal(await run(false), ID("a1"), "the mace: the warhammer isn't the character's to use");
  assert.equal(await run(true), ID("a2"), "proficient, the warhammer is as good as the mace");
});

test("an answer the character outgrows is rolled again, from what is on offer then", async () => {
  // The class's skills are rolled first from three, and the answer is taken. The next replay says that answer
  // is no longer allowed (a feature granted later took the same skill), and offers two instead of three.
  const draft = createDraft({ id: ID("d"), worldId: "w", rules: "legacy", now: 1 });
  const rolled = [];
  const roll = async (faces, key) => {
    rolled.push({ key, faces });
    return 1;
  };
  const skills = { ...traitResult, options: { ...traitResult.options, max: 1 } };
  let replays = 0;
  await rollCharacter({
    draft, catalog: CATALOG, free: ["species", "class", "background", "abilities", "equipment", "details"], roll,
    rebuild: async d => {
      replays++;
      const answered = (d.recipe.steps ?? []).length > 0;
      if ( !answered ) {
        // Second time around the first skill is gone from the pool, so the dice can't pick it again.
        const options = { ...skills.options, allowed: replays > 1 ? ["skills:his", "skills:inv"] : skills.options.allowed };
        return { results: [{ ...skills, options }], roots: {}, actor: null };
      }
      // The stored answer is the one that stopped fitting — until it is rolled from the shorter pool.
      const chosen = d.recipe.steps[0].data.chosen;
      const stale = chosen.includes("skills:arc");
      return { roots: {}, actor: null, results: [{ ...skills, status: stale ? "invalid" : "done",
        errors: stale ? [{ code: "NOT_ALLOWED", detail: chosen }] : [] }] };
    },
    equipmentContext: async () => null
  });
  assert.deepEqual(draft.recipe.steps[0].data.chosen, ["skills:his"], "rolled again from what was left");
  assert.deepEqual(rolled.map(r => r.faces), [3, 2], "three to choose from, then the two still on offer");
});

/* -------------------------------------------- */
/*  Stages above level 1 (D35, D36, D39)         */
/* -------------------------------------------- */

import { checkStagePicks, clearRolled as clearForReplay } from "../scripts/rules/random-check.mjs";
import { openStage } from "../scripts/rules/random.mjs";

const SUBS = ["a", "b", "c", "d", "e"].map(n => U("subclasses", n));
const subclassResult = { key: `class#${ID("sub")}@3`, path: ["class"], advancementId: ID("sub"), level: 3, at: 3, item: "Cleric",
  title: "Divine Domain", type: "Subclass", status: "needsInput", data: null, options: { type: "Subclass", options: SUBS } };
const laterTrait = { ...traitResult, key: "class#late@5", advancementId: ID("late"), level: 5, at: 5 };
const earlyTrait = { ...traitResult, key: "class#early@1", advancementId: ID("early"), at: 1 };

async function stagesRun({ config, results, draft: given = null, totals = [] }) {
  const draft = given ?? createDraft({ id: ID("d"), worldId: "w", rules: "legacy", level: 5, now: 1 });
  const rolled = [];
  const queue = [...totals];
  const roll = async (faces, key) => {
    const total = queue.length ? queue.shift() : 1;
    rolled.push({ key, faces, total });
    return total;
  };
  const free = ["species", "class", "background", "abilities", "equipment", "details"];
  await rollCharacter({
    draft, catalog: CATALOG, free, roll, stages: config,
    rebuild: async d => {
      const answered = new Set((d.recipe.steps ?? []).map(s => s.advancementId));
      return { results: results.map(r => (answered.has(r.advancementId) ? { ...r, status: "done" } : r)), roots: {}, actor: null };
    },
    equipmentContext: async () => null
  });
  return { draft, rolled };
}

test("a subclass is a shortlist the player picks from, and nothing after it is rolled until they have (D39)", async () => {
  const config = { subclass: { size: 3 }, feats: { mode: "shortlist", size: 3 } };
  const { draft, rolled } = await stagesRun({ config, results: [earlyTrait, subclassResult, laterTrait] });
  const stage = draft.random.stages[subclassResult.key];
  assert.equal(stage.kind, "subclass");
  assert.equal(stage.options.length, 3, "three of the five");
  assert.equal(new Set(stage.options).size, 3, "all different");
  assert.ok(draft.recipe.steps.some(s => s.advancementId === ID("early")), "the level-1 choice is rolled");
  assert.ok(!draft.recipe.steps.some(s => s.advancementId === ID("late")), "the level-5 one waits for the pick");
  assert.ok(!draft.recipe.steps.some(s => s.advancementId === ID("sub")), "the pick is the player's");
  assert.deepEqual(rolled.filter(r => r.key.startsWith("shortlist:")).map(r => r.faces), [5, 4, 3]);
  assert.equal(openStage(draft, { results: [subclassResult] })?.key, subclassResult.key);
});

test("0 offers every subclass, with no dice (D39)", async () => {
  const { draft, rolled } = await stagesRun({ config: { subclass: { size: 0 } }, results: [subclassResult] });
  assert.deepEqual([...draft.random.stages[subclassResult.key].options].sort(), [...SUBS].sort());
  assert.equal(rolled.filter(r => r.key.startsWith("shortlist:")).length, 0);
});

test("once the player has picked, the loop carries on, and the GM holds the pick to the list", async () => {
  const config = { subclass: { size: 3 } };
  const { draft } = await stagesRun({ config, results: [subclassResult, laterTrait] });
  const pick = draft.random.stages[subclassResult.key].options[1];
  draft.recipe.steps.push({ path: ["class"], advancementId: ID("sub"), level: 3, data: { uuid: pick } });
  await stagesRun({ config, results: [subclassResult, laterTrait], draft });
  assert.ok(draft.recipe.steps.some(s => s.advancementId === ID("late")), "the level-5 choice is rolled now");
  assert.deepEqual(checkStagePicks(draft), []);
  const off = structuredClone(draft);
  const notOffered = SUBS.find(u => !draft.random.stages[subclassResult.key].options.includes(u));
  off.recipe.steps.find(s => s.advancementId === ID("sub")).data.uuid = notOffered;
  assert.deepEqual(checkStagePicks(off).map(e => e.detail.message), ["notOffered"]);
  // The replay starts from the pick, without the list: it rolls the list again and must come to the same one.
  const cleared = clearForReplay(draft, ["species", "class", "background", "abilities", "equipment", "details"]);
  assert.ok(cleared.recipe.steps.some(s => s.advancementId === ID("sub")), "the player's pick stays");
  assert.ok(!cleared.recipe.steps.some(s => s.advancementId === ID("late")), "the dice's answers go");
  assert.equal(cleared.random.stages[subclassResult.key].options, undefined, "the list is rolled again");
});

test("feats rolled outright (D36): a die for the increase or a feat, then the feat", async () => {
  const asi = { key: "class#asi@4", path: ["class"], advancementId: ID("asi"), level: 4, at: 4, item: "Fighter",
    title: "Ability Score Improvement", type: "AbilityScoreImprovement", status: "needsInput", data: null,
    options: { type: "AbilityScoreImprovement", fixed: {}, points: 2, cap: 2, locked: [], improvable: ["str", "dex"],
      allowFeat: true, feats: [U("feats", "b"), U("feats", "a")] } };
  const { draft, rolled } = await stagesRun({ config: { feats: { mode: "rolled" } }, results: [asi], totals: [2, 1] });
  assert.deepEqual(draft.recipe.steps.find(s => s.advancementId === ID("asi")).data, { type: "feat", uuid: U("feats", "a") });
  assert.deepEqual(rolled.map(r => r.key), ["choice:class#asi@4:branch", "choice:class#asi@4:feat"]);
});

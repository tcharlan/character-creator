import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraft } from "../scripts/contracts.mjs";
import { setMulticlass, shiftSplit, sameSplit, levelsModel, firstClassLevels } from "../scripts/wizard/levels-step.mjs";

/* The class step's levels panel (PLAN 8.4; D32, D35, D37). */

const ID = n => String(n).padEnd(16, "0");
const U = n => `Compendium.test.classes.Item.${ID(n)}`;
const entries = ["fighter", "wizard", "rogue", "cleric"].map(id => ({ uuid: U(id), name: id[0].toUpperCase() + id.slice(1),
  system: { identifier: id } }));
const catalog = { byCategory: { class: entries }, get: uuid => entries.find(e => e.uuid === uuid) };
const draft = (level = 5) => {
  const d = createDraft({ id: ID("d"), worldId: "w", rules: "legacy", level, now: 1 });
  d.picks.class = U("fighter");
  return d;
};

test("+ takes a level from the first class, − gives it back, and a class at 0 isn't taken", () => {
  let split = shiftSplit([], U("wizard"), 1, 3);
  assert.deepEqual(split, [{ uuid: U("wizard"), levels: 1 }]);
  split = shiftSplit(split, U("wizard"), 1, 3);
  assert.deepEqual(split, [{ uuid: U("wizard"), levels: 2 }]);
  assert.deepEqual(shiftSplit(split, U("rogue"), 1, 3), split, "the first class keeps its first level");
  assert.deepEqual(shiftSplit(shiftSplit(split, U("wizard"), -1, 3), U("wizard"), -1, 3), [], "back to 0: not taken");
  assert.deepEqual(shiftSplit([], U("rogue"), -1, 3), [], "nothing below 0");
});

test("confirming writes the split, and a class no longer taken goes with its answers and spells", () => {
  const d = setMulticlass(draft(), [{ uuid: U("wizard"), levels: 1 }], catalog);
  assert.equal(firstClassLevels(d), 4);
  d.recipe.steps = [{ path: ["multiclass:wizard"], advancementId: ID("a"), level: 1, data: {} },
    { path: ["class"], advancementId: ID("b"), level: 1, data: {} }];
  d.multiclassSpells = { "multiclass:wizard": { cantrips: [], spells: [], spellbook: [] } };
  setMulticlass(d, [], catalog);
  assert.deepEqual(d.multiclass, []);
  assert.deepEqual(d.recipe.steps.map(s => s.path[0]), ["class"], "the Wizard's answers go with it");
  assert.deepEqual(d.multiclassSpells, {});
});

test("no class twice, not the first class again, never more than the levels allow", () => {
  const d = setMulticlass(draft(4), [{ uuid: U("fighter"), levels: 1 }, { uuid: U("rogue"), levels: 2 },
    { uuid: U("rogue"), levels: 1 }, { uuid: U("cleric"), levels: 5 }], catalog);
  assert.deepEqual(d.multiclass, [{ uuid: U("rogue"), levels: 2 }, { uuid: U("cleric"), levels: 1 }]);
  assert.ok(sameSplit([{ uuid: U("a"), levels: 1 }, { uuid: U("b"), levels: 2 }], [{ uuid: U("b"), levels: 2 }, { uuid: U("a"), levels: 1 }]));
});

test("the panel: every class a row, all levels in the first to start, the split on screen until confirmed", () => {
  assert.equal(levelsModel(draft(1), catalog, { multiclass: true }), null, "only above level 1");
  const single = levelsModel(draft(5), catalog);
  assert.deepEqual([single.first.levels, single.others.length], [5, 0], "no multiclassing: just the first class");
  const all = levelsModel(draft(5), catalog, { multiclass: true, qualifies: u => u !== U("cleric") });
  assert.deepEqual(all.others.map(o => [o.name, o.levels, o.qualifies]), [["Cleric", 0, false], ["Rogue", 0, true], ["Wizard", 0, true]]);
  assert.equal(all.dirty, false);
  const onScreen = levelsModel(draft(5), catalog, { multiclass: true, split: [{ uuid: U("rogue"), levels: 2 }] });
  assert.deepEqual(onScreen.others.map(o => [o.name, o.levels]), [["Cleric", 0], ["Rogue", 2], ["Wizard", 0]],
    "the rows stay in the same order whatever has levels, so a click never lands on another class");
  assert.equal(onScreen.first.levels, 3);
  assert.ok(onScreen.dirty, "not yet confirmed");
  assert.equal(onScreen.line, "Fighter 3 / Rogue 2");
});

test("hardcore (D35): only the classes the dice offered, and nothing to change past the stage", () => {
  const offered = levelsModel(draft(5), catalog, { offered: [U("rogue"), U("cleric")] });
  assert.deepEqual(offered.others.map(o => o.name).sort(), ["Cleric", "Rogue"]);
  assert.ok(offered.others.every(o => o.canRaise));
  const past = levelsModel(draft(5), catalog, { offered: [U("rogue")], readOnly: true });
  assert.ok(past.others.every(o => !o.canRaise && !o.canLower));
});

test("the GM's minimum in the first class (D35): + stops there, and so does the confirmed split", () => {
  let split = [];
  for ( let i = 0; i < 5; i++ ) split = shiftSplit(split, U("wizard"), 1, 6, { firstMinimum: 3 });
  assert.deepEqual(split, [{ uuid: U("wizard"), levels: 3 }], "a level-6 Fighter keeps 3");
  const d = setMulticlass(draft(6), [{ uuid: U("wizard"), levels: 5 }], catalog, { firstMinimum: 3 });
  assert.deepEqual(d.multiclass, [{ uuid: U("wizard"), levels: 3 }]);
  const panel = levelsModel(draft(6), catalog, { multiclass: true, split, firstMinimum: 3 });
  assert.ok(panel.others.every(o => !o.canRaise), "no more + once the first class is at its minimum");
});

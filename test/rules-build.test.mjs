import { test } from "node:test";
import assert from "node:assert/strict";
import { levelSchedule } from "../scripts/rules/build.mjs";
import { firstChangedLevel } from "../scripts/rules/resume.mjs";

/*
 * Which class each character level goes to (D37, class order): the first class's levels first, then each other
 * class's in the draft's order. Pure: the rest of build.mjs needs Foundry and is covered by Quench.
 */

const roots = s => s.slice(1).map(x => `${x.root}${x.classLevel}`);

test("one class takes every level", () => {
  assert.deepEqual(roots(levelSchedule(1)), ["class1"]);
  assert.deepEqual(roots(levelSchedule(4)), ["class1", "class2", "class3", "class4"]);
});

test("the first class's levels come first, then each other class's, in order", () => {
  const others = [{ root: "multiclass:rogue", levels: 2 }, { root: "multiclass:cleric", levels: 1 }];
  assert.deepEqual(roots(levelSchedule(6, others)),
    ["class1", "class2", "class3", "multiclass:rogue1", "multiclass:rogue2", "multiclass:cleric1"]);
});

test("the first class keeps its first level even when the others ask for too many", () => {
  const s = levelSchedule(3, [{ root: "multiclass:rogue", levels: 5 }]);
  assert.deepEqual(roots(s), ["class1", "multiclass:rogue1", "multiclass:rogue2"]);
});

/* -------------------------------------------- */
/*  Where a rebuild starts (D38)                */
/* -------------------------------------------- */


const ID = n => String(n).padEnd(16, "0");
const step = (adv, level, data, path = ["class"]) => ({ path, advancementId: ID(adv), level, data });
const input = over => ({ picks: { species: "s", background: "b", class: "c" }, base: { str: 10 }, level: 8,
  multiclass: [], hitPoints: { rolls: {} }, steps: [step("a", 1, { x: 1 }), step("b", 4, { type: "asi" }), step("c", 6, { y: 1 })],
  ...over });
const results = [
  { key: `class#${ID("a")}@1`, at: 1 }, { key: `class#${ID("b")}@4`, at: 4 }, { key: `class#${ID("c")}@6`, at: 6 },
  { key: `class#${ID("d")}@7`, at: 7 }
];
const prev = { input: input(), results };

test("nothing changed: nothing to replay", () => {
  assert.equal(firstChangedLevel(prev, input()), 9);
});

test("an answer changed, added or dropped: from the level it was met at", () => {
  assert.equal(firstChangedLevel(prev, input({ steps: [step("a", 1, { x: 1 }), step("b", 4, { type: "feat" }), step("c", 6, { y: 1 })] })), 4);
  assert.equal(firstChangedLevel(prev, input({ steps: [...input().steps, step("d", 7, { z: 1 })] })), 7, "the level-7 choice answered");
  assert.equal(firstChangedLevel(prev, input({ steps: input().steps.slice(0, 2) })), 6, "the level-6 answer dropped");
});

test("the picks, the scores or the hit dice: from the start", () => {
  assert.equal(firstChangedLevel(prev, input({ base: { str: 12 } })), 1);
  assert.equal(firstChangedLevel(prev, input({ picks: { species: "s", background: "b", class: "other" } })), 1);
  assert.equal(firstChangedLevel(prev, input({ hitPoints: { rolls: { "fighter@2": { faces: 10, total: 3, messageId: ID("m") } } } })), 1);
  assert.equal(firstChangedLevel(null, input()), 1, "no build yet");
});

test("the level split: from the first level that goes to another class", () => {
  const multi = input({ multiclass: [{ uuid: "rogue", levels: 2 }] });
  assert.equal(firstChangedLevel(prev, multi), 7, "levels 7 and 8 go to the Rogue now");
  assert.equal(firstChangedLevel({ input: multi, results }, input({ multiclass: [{ uuid: "rogue", levels: 3 }] })), 6);
});

test("a higher starting level replays only the new levels; a lower one replays none", () => {
  assert.equal(firstChangedLevel(prev, input({ level: 10 })), 9);
  assert.equal(firstChangedLevel(prev, input({ level: 5 })), 6);
});

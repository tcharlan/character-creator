import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraft, checkDraftShape } from "../scripts/contracts.mjs";
import { checkAbilities } from "../scripts/rules/abilities.mjs";
import { setMethod, spendPoint, assignValue, poolFor, startingScores, abilitiesModel }
  from "../scripts/wizard/abilities-step.mjs";

const ID = n => String(n).padEnd(16, "0");
const draft = abilities => {
  const d = createDraft({ id: ID("d"), worldId: "w", rules: "legacy", now: 1 });
  if ( abilities ) d.abilities = abilities;
  return d;
};
const row = (model, key) => model.rows.find(r => r.key === key);

test("choosing a method starts it off: point buy at the minimum, the others unassigned", () => {
  assert.deepEqual(startingScores("pointBuy"), { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 });
  assert.deepEqual(startingScores("standardArray"), { str: null, dex: null, con: null, int: null, wis: null, cha: null },
    "assigned methods start with six empty scores, so a half-filled draft still saves");
  assert.equal(startingScores(null), null);
  const d = setMethod(draft(), "pointBuy");
  assert.equal(d.abilities.method, "pointBuy");
  assert.equal(d.abilities.base.str, 8);
  assert.deepEqual(checkDraftShape(d), []);
});

test("switching method clears the old scores; a roll is kept (A10)", () => {
  const rolled = { method: "rolled", base: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
    roll: { messageId: ID("m"), results: [15, 14, 13, 12, 10, 8] } };
  const d = setMethod(draft(rolled), "pointBuy");
  assert.equal(d.abilities.base.str, 8);
  assert.equal(d.abilities.roll, null, "point buy has no roll");
  const back = setMethod(d, "rolled");
  assert.deepEqual(back.abilities.base, { str: null, dex: null, con: null, int: null, wis: null, cha: null },
    "the scores are assigned again from the roll");
});

test("point buy: costs, the 27-point budget and the 8–15 range", () => {
  let d = setMethod(draft(), "pointBuy");
  for ( let i = 0; i < 7; i++ ) d = spendPoint(d, "str", 1);
  assert.equal(d.abilities.base.str, 15, "8 to 15 costs 9 of 27");
  d = spendPoint(d, "str", 1);
  assert.equal(d.abilities.base.str, 15, "15 is the maximum");
  d = spendPoint(d, "dex", 1);
  d = spendPoint(d, "dex", 1);
  d = spendPoint(d, "dex", 1);
  d = spendPoint(d, "dex", 1);
  d = spendPoint(d, "dex", 1);
  d = spendPoint(d, "dex", 1);
  d = spendPoint(d, "dex", 1);
  assert.equal(d.abilities.base.dex, 15, "9 + 9 = 18 of 27");
  d = spendPoint(d, "con", 1);
  d = spendPoint(d, "con", 1);
  d = spendPoint(d, "con", 1);
  d = spendPoint(d, "con", 1);
  d = spendPoint(d, "con", 1);
  d = spendPoint(d, "con", 1);
  assert.equal(d.abilities.base.con, 14, "the last point can't be afforded (9+9+9 > 27)");
  const model = abilitiesModel(d, {});
  assert.deepEqual([model.pointBuy.spent, model.pointBuy.remaining], [25, 2]);
  assert.equal(row(model, "con").canRaise, true, "14 to 15 costs exactly the 2 points left");
  assert.equal(row(model, "int").canRaise, true, "8 to 9 costs 1");
  const spent = spendPoint(d, "con", 1);
  const full = abilitiesModel(spent, {});
  assert.deepEqual([full.pointBuy.spent, full.pointBuy.remaining], [27, 0]);
  assert.equal(row(full, "int").canRaise, false, "nothing left to spend");
  assert.deepEqual(checkAbilities(spent.abilities), [], "27 points exactly is a legal spread");
  d = spendPoint(d, "str", -1);
  assert.equal(d.abilities.base.str, 14);
  const floor = spendPoint(setMethod(draft(), "pointBuy"), "wis", -1);
  assert.equal(floor.abilities.base.wis, 8, "8 is the minimum");
});

test("standard array and rolled: values are assigned once, and swap when taken", () => {
  let d = setMethod(draft(), "standardArray");
  assert.deepEqual(poolFor(d.abilities), [15, 14, 13, 12, 10, 8]);
  d = assignValue(d, "str", 15);
  d = assignValue(d, "dex", 14);
  assert.deepEqual(d.abilities.base, { str: 15, dex: 14, con: null, int: null, wis: null, cha: null });
  d = assignValue(d, "dex", 15);
  assert.deepEqual(d.abilities.base, { str: 14, dex: 15, con: null, int: null, wis: null, cha: null }, "the two swapped");
  d = assignValue(d, "con", 13);
  d = assignValue(d, "int", 12);
  d = assignValue(d, "wis", 10);
  d = assignValue(d, "cha", 8);
  assert.deepEqual(checkAbilities(d.abilities), [], "a full assignment is legal");
  assert.equal(abilitiesModel(d, {}).complete, true);
  const model = abilitiesModel(assignValue(d, "cha", null), {});
  assert.equal(model.complete, false);
  assert.deepEqual(model.spare, [8], "the freed value is offered again");
  assert.deepEqual(row(model, "cha").choices, [8]);
  assert.deepEqual(row(model, "str").choices, [14, 8], "its own value (14 after the swap), plus what's spare");
});

test("rolled: the pool is the recorded roll", () => {
  const abilities = { method: "rolled", base: null, roll: { messageId: ID("m"), results: [16, 9, 12, 14, 11, 7] } };
  const model = abilitiesModel(draft(abilities), {});
  assert.deepEqual(model.pool, [16, 9, 12, 14, 11, 7]);
  assert.deepEqual(model.rolled, { rolled: true, formula: "4d6kh3", count: 6, results: [16, 9, 12, 14, 11, 7],
    resultsText: "16, 9, 12, 14, 11, 7" });
  assert.equal(model.complete, false);
  const none = abilitiesModel(draft({ method: "rolled", base: null, roll: null }), {});
  assert.equal(none.rolled.rolled, false);
});

test("the model offers only the methods the GM allows, and shows the final scores", () => {
  const d = setMethod(draft(), "pointBuy");
  const model = abilitiesModel(d, { allowedMethods: ["pointBuy"], finals: { str: { value: 10, mod: 0 } } });
  assert.deepEqual(model.methods.map(m => m.key), ["pointBuy"]);
  assert.equal(model.onlyOne, true);
  assert.deepEqual([row(model, "str").final, row(model, "str").bonus, row(model, "str").modifier], [10, 2, 0]);
  assert.equal(row(model, "dex").final, null, "no final score known yet");
  assert.deepEqual(abilitiesModel(draft(), {}).methods.map(m => m.key), ["pointBuy", "standardArray", "rolled"]);
  assert.equal(abilitiesModel(draft(), {}).method, null);
});

test("a pool with the same value twice offers both, and only swaps when none is spare", () => {
  const abilities = { method: "rolled", base: null, roll: { messageId: ID("m"), results: [13, 12, 12, 11, 9, 9] } };
  let d = draft(abilities);
  d = assignValue(d, "str", 12);
  d = assignValue(d, "dex", 12);
  assert.deepEqual([d.abilities.base.str, d.abilities.base.dex], [12, 12], "both copies can be used");
  const model = abilitiesModel(d, {});
  assert.deepEqual(model.spare, [13, 11, 9, 9]);
  assert.deepEqual(model.rows.find(r => r.key === "con").choices, [13, 11, 9, 9], "duplicates are kept");
  d = assignValue(d, "con", 12);
  assert.deepEqual([d.abilities.base.str, d.abilities.base.dex, d.abilities.base.con], [null, 12, 12],
    "no third copy: the first holder gives it up");
  assert.deepEqual(checkDraftShape(d), []);
});

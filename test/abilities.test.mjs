import { test } from "node:test";
import assert from "node:assert/strict";
import { POINT_BUY, STANDARD_ARRAY, ABILITY_ROLL, ROLL_PURPOSE, pointBuyCost, checkAbilities, checkRollRecord }
  from "../scripts/rules/abilities.mjs";

const base = (...v) => ({ str: v[0], dex: v[1], con: v[2], int: v[3], wis: v[4], cha: v[5] });
const codes = errs => errs.map(e => e.code);
const detail = errs => errs[0]?.detail;

test("the point-buy table is the PHB's", () => {
  assert.deepEqual({ ...POINT_BUY.cost }, { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 });
  assert.equal(POINT_BUY.budget, 27);
  assert.deepEqual(pointBuyCost(base(15, 15, 15, 8, 8, 8)), { spent: 27, remaining: 0, outOfRange: [] });
  assert.deepEqual(pointBuyCost(base(8, 8, 8, 8, 8, 8)), { spent: 0, remaining: 27, outOfRange: [] });
  assert.deepEqual(pointBuyCost(base(16, 7, 8, 8, 8, 8.5)).outOfRange, ["str", "dex", "cha"]);
});

test("point buy: exactly 27 points with every score 8–15", () => {
  const ok = { method: "pointBuy", base: base(15, 14, 13, 12, 10, 8), roll: null };   // 9+7+5+4+2+0
  assert.deepEqual(checkAbilities(ok), []);
  assert.deepEqual(checkAbilities({ ...ok, base: base(15, 15, 15, 8, 8, 8) }), []);
  assert.deepEqual(checkAbilities({ ...ok, base: base(13, 13, 13, 12, 12, 12) }), []);   // 15 + 12
  const over = checkAbilities({ ...ok, base: base(15, 15, 15, 9, 8, 8) });
  assert.deepEqual(codes(over), ["POINT_BUY_INVALID"]);
  assert.equal(detail(over).spent, 28);
  const under = checkAbilities({ ...ok, base: base(15, 14, 13, 12, 8, 8) });
  assert.deepEqual(codes(under), ["POINT_BUY_INVALID"]);
  assert.equal(detail(under).spent, 25);
  assert.deepEqual(detail(checkAbilities({ ...ok, base: base(16, 14, 13, 8, 8, 8) })).outOfRange, ["str"]);
  assert.deepEqual(detail(checkAbilities({ ...ok, base: base(15, 15, 15, 7, 9, 9) })).outOfRange, ["int"]);
  assert.deepEqual(codes(checkAbilities({ ...ok, base: null })), ["POINT_BUY_INVALID"]);
  assert.deepEqual(codes(checkAbilities({ ...ok, base: { str: 15, dex: 15, con: 15 } })), ["POINT_BUY_INVALID"]);
});

test("standard array: each value used exactly once, in any order", () => {
  const ok = { method: "standardArray", base: base(8, 10, 12, 13, 14, 15), roll: null };
  assert.deepEqual(checkAbilities(ok), []);
  assert.deepEqual(checkAbilities({ ...ok, base: base(...STANDARD_ARRAY) }), []);
  for ( const b of [base(15, 15, 13, 12, 10, 8), base(15, 14, 13, 12, 10, 9), base(15, 14, 13, 12, 10, null),
    base(15, 14, 13, 12, 10, "8")] ) {
    assert.deepEqual(codes(checkAbilities({ ...ok, base: b })), ["STANDARD_ARRAY_INVALID"], JSON.stringify(b));
  }
});

test("method: missing, unknown or not allowed by the GM", () => {
  const sa = { method: "standardArray", base: base(...STANDARD_ARRAY), roll: null };
  assert.deepEqual(codes(checkAbilities({ ...sa, method: null })), ["ABILITY_METHOD_NOT_ALLOWED"]);
  assert.deepEqual(codes(checkAbilities({ ...sa, method: "manual" })), ["ABILITY_METHOD_NOT_ALLOWED"]);
  assert.deepEqual(codes(checkAbilities(sa, { allowedMethods: ["pointBuy"] })), ["ABILITY_METHOD_NOT_ALLOWED"]);
  assert.deepEqual(checkAbilities(sa, { allowedMethods: ["standardArray"] }), []);
  assert.deepEqual(codes(checkAbilities(undefined)), ["ABILITY_METHOD_NOT_ALLOWED"]);
});

test("rolled: the scores are the recorded results, assigned in any order", () => {
  const results = [16, 9, 12, 14, 11, 7];
  const ok = { method: "rolled", base: base(7, 9, 11, 12, 14, 16), roll: { messageId: "a".repeat(16), results } };
  assert.deepEqual(checkAbilities(ok), []);
  assert.deepEqual(codes(checkAbilities({ ...ok, base: base(8, 9, 11, 12, 14, 16) })), ["ROLL_INVALID"]);
  assert.deepEqual(codes(checkAbilities({ ...ok, base: base(16, 16, 11, 12, 14, 7) })), ["ROLL_INVALID"]);
  assert.deepEqual(detail(checkAbilities({ ...ok, roll: null })), { notRolled: true });
  assert.deepEqual(codes(checkAbilities({ ...ok, roll: { ...ok.roll, results: results.slice(0, 5) } })), ["ROLL_INVALID"]);
});

test("rolled results lock in: switching method after rolling is rejected (A10)", () => {
  const roll = { messageId: "a".repeat(16), results: [15, 14, 13, 12, 10, 8] };
  const errs = checkAbilities({ method: "standardArray", base: base(...STANDARD_ARRAY), roll });
  assert.deepEqual(codes(errs), ["ROLL_INVALID"]);
  assert.deepEqual(detail(errs), { rolledButMethod: "standardArray" });
});

/* -------------------------------------------- */
/*  Roll records                                */
/* -------------------------------------------- */

const DRAFT = "D".repeat(16);
const USER = "U".repeat(16);
/** A 4d6kh3 roll record from four dice (the lowest dropped). */
const die = (...faces) => {
  const low = faces.indexOf(Math.min(...faces));
  const results = faces.map((result, i) => ({ result, active: i !== low }));
  return { formula: ABILITY_ROLL.formula, total: faces.reduce((a, b) => a + b, 0) - faces[low],
    dice: [{ number: 4, faces: 6, results }] };
};
const record = over => ({
  id: "M".repeat(16), authorId: USER, public: true, created: 1000, modified: 1000,
  flag: { draftId: DRAFT, purpose: ROLL_PURPOSE.ABILITIES },
  rolls: [die(6, 5, 5, 1), die(3, 3, 3, 3), die(1, 1, 1, 1), die(6, 6, 6, 6), die(2, 4, 6, 1), die(5, 4, 3, 2)],
  ...over
});
const RESULTS = [16, 9, 3, 18, 12, 12];
const expected = over => ({ draftId: DRAFT, userId: USER, results: RESULTS, ...over });
const why = errs => errs[0]?.detail?.message;

test("roll record: an untouched roll for this draft by this player passes", () => {
  assert.deepEqual(record().rolls.map(r => r.total), RESULTS);
  assert.deepEqual(checkRollRecord(record(), expected()), []);
});

test("roll record: missing, another player's, another draft's, whispered or edited", () => {
  assert.equal(why(checkRollRecord(null, expected())), "missing");
  assert.equal(why(checkRollRecord(record({ authorId: "X".repeat(16) }), expected())), "wrongAuthor");
  assert.equal(why(checkRollRecord(record({ flag: { draftId: "E".repeat(16), purpose: "abilities" } }), expected())), "wrongDraft");
  assert.equal(why(checkRollRecord(record({ flag: null }), expected())), "wrongDraft");
  assert.equal(why(checkRollRecord(record({ flag: { draftId: DRAFT, purpose: "wealth" } }), expected())), "wrongDraft");
  assert.equal(why(checkRollRecord(record({ public: false }), expected())), "notPublic");
  assert.equal(why(checkRollRecord(record({ modified: 3000 }), expected())), "edited");
  assert.equal(why(checkRollRecord(record({ modified: null }), expected())), "edited");
  assert.deepEqual(checkRollRecord(record({ modified: 1001 }), expected()), [], "creation stamps ~1 ms apart");
  assert.equal(why(checkRollRecord(record(), expected({ others: ["N".repeat(16)] }))), "rerolled");
  for ( const e of [checkRollRecord(null, expected())] ) assert.deepEqual(codes(e), ["ROLL_INVALID"]);
});

test("roll record: draft results that differ from the dice (edited draft) are rejected", () => {
  assert.equal(why(checkRollRecord(record(), expected({ results: [18, 9, 3, 18, 12, 12] }))), "resultsDiffer");
  assert.equal(why(checkRollRecord(record(), expected({ results: [9, 16, 3, 18, 12, 12] }))), "resultsDiffer", "order matters");
  assert.equal(why(checkRollRecord(record(), expected({ results: RESULTS.slice(0, 5) }))), "resultsDiffer");
});

test("roll record: hand-made or inconsistent rolls are rejected", () => {
  const withRoll = (i, r) => record({ rolls: record().rolls.map((x, j) => (j === i ? r : x)) });
  const bad = (r, problem) => {
    const errs = checkRollRecord(withRoll(0, r), expected());
    assert.equal(why(errs), "badRoll", problem);
    assert.equal(errs[0].detail.problem, problem);
  };
  const good = die(6, 5, 5, 1);
  bad({ ...good, formula: "4d6" }, "formula");
  bad({ ...good, formula: "3d6" }, "formula");
  bad({ ...good, dice: [{ ...good.dice[0], number: 3 }] }, "dice");
  bad({ ...good, dice: [...good.dice, good.dice[0]] }, "dice");
  bad({ ...good, dice: [{ ...good.dice[0], results: good.dice[0].results.slice(0, 3) }] }, "faces");
  bad({ ...good, dice: [{ ...good.dice[0], results: [{ result: 7, active: true }, ...good.dice[0].results.slice(1)] }] }, "faces");
  bad({ ...good, dice: [{ ...good.dice[0], results: good.dice[0].results.map(r => ({ ...r, active: r.result !== 6 })) }] }, "kept");
  bad({ ...good, total: 17 }, "total");
  assert.equal(why(checkRollRecord(record({ rolls: record().rolls.slice(0, 5) }), expected())), "rollCount");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { slotsToRoll, checkHitPointRecords, usedSlots } from "../scripts/rules/hit-points.mjs";

/* Rolled hit points (D33): one roll per class level, kept by slot, checked against chat. */

const ID = n => String(n).padEnd(16, "0");
const draft = rolls => ({ id: ID("d"), hitPoints: { rolls } });
const record = (id, slots, totals, over = {}) => ({
  id, authorId: ID("u"), public: true, created: 1000, modified: 1001,
  flag: { draftId: ID("d"), purpose: "hitPoints", slots },
  rolls: totals.map(([faces, total]) => ({ formula: `1d${faces}`, total, dice: [{ number: 1, faces, results: [{ result: total, active: true }] }] })),
  ...over
});

test("the hit dice a build waits on, once each", () => {
  const build = { results: [
    { type: "HitPoints", status: "needsInput", slot: "fighter@2", faces: 10 },
    { type: "HitPoints", status: "auto", slot: "fighter@1", faces: 10 },
    { type: "HitPoints", status: "needsInput", slot: "wizard@1", faces: 6 },
    { type: "HitPoints", status: "needsInput", slot: "wizard@1", faces: 6 }
  ] };
  assert.deepEqual(slotsToRoll(build), [{ slot: "fighter@2", faces: 10 }, { slot: "wizard@1", faces: 6 }]);
  assert.deepEqual(usedSlots({ results: [{ type: "HitPoints", level: 2, data: { 2: 7 }, slot: "fighter@2" },
    { type: "HitPoints", level: 1, data: { 1: "max" }, slot: "fighter@1" }] }), ["fighter@2"]);
});

test("rolls on record match: accepted", () => {
  const d = draft({ "fighter@2": { faces: 10, total: 7, messageId: ID("m1") }, "wizard@1": { faces: 6, total: 2, messageId: ID("m1") } });
  const records = [record(ID("m1"), ["fighter@2", "wizard@1"], [[10, 7], [6, 2]])];
  assert.deepEqual(checkHitPointRecords(d, records, { userId: ID("u"), used: ["fighter@2", "wizard@1"] }), []);
});

test("edited, re-rolled, borrowed or missing rolls are refused", () => {
  const d = draft({ "fighter@2": { faces: 10, total: 9, messageId: ID("m1") } });
  const check = (records, used = ["fighter@2"]) => checkHitPointRecords(d, records, { userId: ID("u"), used })
    .map(e => e.detail.message);
  assert.deepEqual(check([record(ID("m1"), ["fighter@2"], [[10, 7]])]), ["resultsDiffer"], "the draft claims a 9, chat says 7");
  assert.deepEqual(check([record(ID("m1"), ["fighter@2"], [[10, 9]]), record(ID("m2"), ["fighter@2"], [[10, 3]])]), ["rerolled"]);
  assert.deepEqual(check([record(ID("m1"), ["fighter@2"], [[10, 9]], { modified: 9000 })]), ["edited"]);
  assert.deepEqual(check([record(ID("m1"), ["fighter@2"], [[10, 9]], { authorId: ID("x") })]), ["wrongAuthor"]);
  assert.deepEqual(check([]), ["noMessage"]);
  assert.deepEqual(check([], ["rogue@2"]), ["missing"], "a slot the character uses with no roll at all");
});

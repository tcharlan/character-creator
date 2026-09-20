import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraft, checkDraftShape } from "../scripts/contracts.mjs";
import { applyPick, answerStep, stepsForRole } from "../scripts/wizard/picks.mjs";

const ID = n => String(n).padEnd(16, "0");
const U = n => `Compendium.test.x.Item.${ID(n)}`;
const step = (role, n, data = { chosen: ["skills:ath"] }) => ({ path: [role], advancementId: ID(n), level: 1, data });

function draft() {
  const d = createDraft({ id: ID("d"), worldId: "w", rules: "legacy", now: 1 });
  d.picks = { species: U("sp"), background: U("bg"), class: U("cl") };
  d.recipe.steps = [step("species", "a"), step("background", "b"), step("class", "c"), step("class", "d")];
  d.equipment = { class: { mode: "items", choices: {}, picks: {} }, background: { mode: "items", choices: {}, picks: {} } };
  d.spells = { cantrips: [U("s1")], spells: [], spellbook: [] };
  return d;
}

test("changing the class drops its answers, its equipment and the class spells", () => {
  const d = applyPick(draft(), "class", U("cl2"));
  assert.equal(d.picks.class, U("cl2"));
  assert.deepEqual(stepsForRole(d, "class"), []);
  assert.equal(stepsForRole(d, "species").length, 1, "the species keeps its answers");
  assert.equal(d.equipment.class, null);
  assert.deepEqual(d.equipment.background, { mode: "items", choices: {}, picks: {} }, "the background keeps its equipment (D23)");
  assert.deepEqual(d.spells, { cantrips: [], spells: [], spellbook: [] });
  assert.deepEqual(checkDraftShape(d), []);
});

test("changing the background drops its answers and its equipment only", () => {
  const d = applyPick(draft(), "background", U("bg2"));
  assert.deepEqual(stepsForRole(d, "background"), []);
  assert.equal(stepsForRole(d, "class").length, 2);
  assert.equal(d.equipment.background, null);
  assert.notEqual(d.equipment.class, null);
  assert.equal(d.spells.cantrips.length, 1, "class spells are untouched");
});

test("changing the species drops only its answers; picking the same option changes nothing", () => {
  const d = applyPick(draft(), "species", U("sp2"));
  assert.deepEqual(stepsForRole(d, "species"), []);
  assert.equal(d.recipe.steps.length, 3);
  assert.notEqual(d.equipment.class, null);
  const same = applyPick(draft(), "class", U("cl"));
  assert.equal(same.recipe.steps.length, 4, "nothing dropped when the pick is unchanged");
  assert.throws(() => applyPick(draft(), "nonsense", U("x")), /Unknown role/);
});

test("clearing a pick is allowed", () => {
  const d = applyPick(draft(), "species", null);
  assert.equal(d.picks.species, null);
  assert.deepEqual(stepsForRole(d, "species"), []);
  assert.deepEqual(checkDraftShape(d), []);
});

test("answering a step replaces the earlier answer for it", () => {
  const d = draft();
  answerStep(d, { path: ["class"], advancementId: ID("c"), level: 1 }, { chosen: ["skills:per"] });
  const forC = d.recipe.steps.filter(s => s.advancementId === ID("c"));
  assert.equal(forC.length, 1);
  assert.deepEqual(forC[0].data, { chosen: ["skills:per"] });
  assert.equal(d.recipe.steps.length, 4);
  answerStep(d, { path: ["class", `${ID("sub")}:${U("life")}`], advancementId: ID("e"), level: 1 }, { uuid: U("x") });
  assert.equal(d.recipe.steps.length, 5, "a different path is a different step");
  assert.deepEqual(checkDraftShape(d), []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraft, checkDraftShape } from "../scripts/contracts.mjs";
import { buildTree, wealthOption, resolveSelection } from "../scripts/rules/equipment.mjs";
import { sourceModel, entryLabel, setMode, chooseBranch, setPick, setWealth } from "../scripts/wizard/equipment-step.mjs";

const ID = n => String(n).padEnd(16, "0");
const U = n => `Compendium.test.items.Item.${ID(n)}`;
const e = (_id, type, group = "", extra = {}) => ({ _id, type, group: group || "", sort: 0, ...extra });

/** A 2014-style class: "mace or warhammer (if proficient)", "any martial weapon ×2", a fixed pack, and 15 gp. */
const ENTRIES = [
  e(ID("or1"), "OR", ""),
  e(ID("a1"), "linked", ID("or1"), { key: U("mace"), sort: 1 }),
  e(ID("a2"), "linked", ID("or1"), { key: U("hammer"), sort: 2, requiresProficiency: true }),
  e(ID("or2"), "OR", "", { sort: 1 }),
  e(ID("b1"), "weapon", ID("or2"), { key: "martialM", count: 2, sort: 1 }),
  e(ID("b2"), "AND", ID("or2"), { sort: 2 }),
  e(ID("b2a"), "linked", ID("b2"), { key: U("bow"), sort: 1 }),
  e(ID("b2b"), "linked", ID("b2"), { key: U("arrow"), count: 20, sort: 2 }),
  e(ID("pack"), "linked", "", { key: U(ID("pack")), sort: 2 }),
  e(ID("coin"), "currency", "", { key: "gp", count: 15, sort: 3 })
];
const NAMES = { [U("mace")]: "Mace", [U("hammer")]: "Warhammer", [U("bow")]: "Longbow", [U("arrow")]: "Arrow",
  [U(ID("pack"))]: "Priest's pack", [U("axe")]: "Battleaxe", [U("sword")]: "Longsword" };
const catalog = { get: uuid => ({ name: NAMES[uuid] ?? "Item" }) };
const tree = buildTree(ENTRIES);
const candidates = node => (node.key === "martialM" ? [U("axe"), U("sword")] : []);
const source = extra => ({ role: "class", name: "Cleric", tree, wealthOption: wealthOption("5d4 * 10"), candidates, ...extra });
const draft = () => createDraft({ id: ID("d"), worldId: "w", rules: "legacy", now: 1 });

test("entries read as sentences", () => {
  assert.equal(entryLabel(tree.nodes.get(ID("a1")), catalog), "Mace");
  assert.equal(entryLabel(tree.nodes.get(ID("b2")), catalog), "Longbow, 20 × Arrow");
  assert.equal(entryLabel(tree.nodes.get(ID("coin")), catalog), "15 GP");
  assert.equal(entryLabel(tree.nodes.get(ID("b1")), catalog), "2 × martialM", "the key is the fallback outside Foundry");
});

test("the model lists the choices to make, with the fixed items alongside", () => {
  const model = sourceModel(source(), null, catalog);
  assert.deepEqual(model.decisions.map(d => [d.kind, d.id]), [["or", ID("or1")], ["or", ID("or2")]]);
  assert.deepEqual(model.decisions[0].options.map(o => o.label), ["Mace", "Warhammer"]);
  assert.deepEqual(model.fixed, ["Priest's pack"]);
  assert.equal(model.complete, false);
  assert.equal(model.wealth.rollable, true);
  assert.deepEqual(model.wealth.range, [50, 200]);
});

test("choosing a branch reveals what it needs; the category picker has one slot per item", () => {
  let d = draft();
  d = chooseBranch(d, "class", ID("or1"), ID("a1"), tree);
  d = chooseBranch(d, "class", ID("or2"), ID("b1"), tree);
  const model = sourceModel(source(), d.equipment.class, catalog);
  const category = model.decisions.find(x => x.kind === "category");
  assert.ok(category, "the weapon picker didn't appear");
  assert.equal(category.count, 2);
  assert.deepEqual(category.slots.map(s => s.uuid), [null, null]);
  assert.deepEqual(category.slots[0].options.map(o => o.name), ["Battleaxe", "Longsword"]);
  assert.equal(model.complete, false, "the slots are still empty");

  d = setPick(d, "class", ID("b1"), 0, U("axe"));
  d = setPick(d, "class", ID("b1"), 1, U("sword"));
  const full = sourceModel(source(), d.equipment.class, catalog);
  assert.equal(full.complete, true);
  assert.deepEqual(checkDraftShape(d), []);
  const resolved = resolveSelection(tree, "5d4 * 10", d.equipment.class,
    { inCategory: (node, uuid) => candidates(node).includes(uuid) });
  assert.deepEqual(resolved.errors, []);
  assert.deepEqual(resolved.items.map(i => catalog.get(i.uuid).name), ["Mace", "Battleaxe", "Longsword", "Priest's pack"]);
  assert.deepEqual(resolved.currency, { gp: 15 });
});

test("switching branch drops the picks that belonged to the old one", () => {
  let d = draft();
  d = chooseBranch(d, "class", ID("or2"), ID("b1"), tree);
  d = setPick(d, "class", ID("b1"), 0, U("axe"));
  assert.deepEqual(d.equipment.class.picks[ID("b1")], [U("axe")]);
  d = chooseBranch(d, "class", ID("or2"), ID("b2"), tree);
  assert.deepEqual(d.equipment.class.picks, {}, "the weapon picks are gone");
  assert.deepEqual(checkDraftShape(d), []);
});

test("an option the character isn't proficient with is flagged", () => {
  const model = sourceModel(source({ isProficient: () => false }), null, catalog);
  assert.deepEqual(model.decisions[0].options.map(o => o.warning), [false, true]);
  const fine = sourceModel(source({ isProficient: () => true }), null, catalog);
  assert.deepEqual(fine.decisions[0].options.map(o => o.warning), [false, false]);
});

test("taking the wealth instead: the choices are cleared, and a rolled total is kept", () => {
  let d = draft();
  d = chooseBranch(d, "class", ID("or1"), ID("a1"), tree);
  d = setMode(d, "class", "wealth");
  assert.deepEqual(d.equipment.class.choices, {}, "item choices don't apply to wealth");
  assert.equal(sourceModel(source(), d.equipment.class, catalog).complete, false, "nothing rolled yet");
  d = setWealth(d, "class", { total: 120, messageId: ID("m") });
  const model = sourceModel(source(), d.equipment.class, catalog);
  assert.deepEqual([model.mode, model.wealth.total, model.wealth.rolled, model.complete], ["wealth", 120, true, true]);
  assert.deepEqual(checkDraftShape(d), []);
  d = setMode(d, "class", "items");
  assert.equal(d.equipment.class.mode, "items");
  assert.deepEqual(checkDraftShape(d), []);
});

test("2024-style flat wealth needs no roll", () => {
  const flat = source({ wealthOption: wealthOption("110") });
  const d = setMode(draft(), "class", "wealth");
  const model = sourceModel(flat, d.equipment.class, catalog);
  assert.deepEqual([model.wealth.fixed, model.wealth.rollable, model.complete], [110, false, true]);
});

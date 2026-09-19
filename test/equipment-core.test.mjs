import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTree, resolveSelection, listDecisions, defaultSelection, wealthOption, EQUIPMENT_ERRORS as E
} from "../spike/equipment-core.mjs";

// Synthetic data with the same structure as dnd5e's EquipmentEntryData (no rules content).
const U = name => `Compendium.test.items.Item.${name.padEnd(16, "0")}`;
const e = (_id, type, group = "", extra = {}) => ({ _id, type, group, sort: 0, ...extra });

/** 2014-style: two ORs, one with a category pair and an "if proficient" option; an AND kit. */
const LEGACY = [
  e("or1", "OR", ""),
  e("a1", "linked", "or1", { key: U("mace"), sort: 1 }),
  e("a2", "linked", "or1", { key: U("warhammer"), sort: 2, requiresProficiency: true }),
  e("or2", "OR", "", { sort: 1 }),
  e("b1", "AND", "or2", { sort: 1 }),
  e("b1x", "weapon", "b1", { key: "martialM", sort: 1 }),
  e("b1y", "armor", "b1", { key: "shield", sort: 2 }),
  e("b2", "weapon", "or2", { key: "martialM", count: 2, sort: 2 }),
  e("and1", "AND", "", { sort: 2 }),
  e("k1", "linked", "and1", { key: U("pack"), sort: 1 }),
  e("k2", "linked", "and1", { key: U("arrow"), count: 20, sort: 2 })
];
/** 2024-style: one AND package with currency, plus a flat wealth alternative. */
const MODERN = [
  e("p", "AND", ""),
  e("p1", "linked", "p", { key: U("staff"), sort: 1 }),
  e("p2", "tool", "p", { key: "art", sort: 2 }),
  e("p3", "currency", "p", { key: "gp", count: 8, sort: 3 })
];

const MARTIAL = [U("longsword"), U("battleaxe")];
const ctx = (proficient = true) => ({
  inCategory: (node, uuid) => ({ martialM: MARTIAL, shield: [U("shield")], art: [U("smith")] })[node.key]?.includes(uuid) ?? false,
  isProficient: () => proficient
});

test("builds a tree from flat entries; top-level group may be '' or null", () => {
  const tree = buildTree([...LEGACY.slice(0, 3), { ...LEGACY[3], group: null }]);
  assert.deepEqual(tree.children.map(n => n._id), ["or1", "or2"]);
  assert.deepEqual(tree.children[0].children.map(n => n._id), ["a1", "a2"]);
});

test("lists only reachable decisions", () => {
  const tree = buildTree(LEGACY);
  assert.deepEqual(listDecisions(tree).map(d => d.id), ["or1", "or2"]);
  const withChoice = listDecisions(tree, { or2: "b2" });
  assert.deepEqual(withChoice.at(-1), { id: "b2", kind: "category", type: "weapon", key: "martialM", count: 2 });
});

test("resolves a full legacy selection into merged items", () => {
  const sel = { mode: "items", choices: { or1: "a1", or2: "b2" }, picks: { b2: [MARTIAL[0], MARTIAL[0]] } };
  const r = resolveSelection(buildTree(LEGACY), "5d4 * 10", sel, ctx());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.items.map(i => [i.uuid, i.count]),
    [[U("mace"), 1], [MARTIAL[0], 2], [U("pack"), 1], [U("arrow"), 20]]);
});

test("an 'if proficient' option needs proficiency", () => {
  const sel = { choices: { or1: "a2", or2: "b1" }, picks: { b1x: [MARTIAL[1]], b1y: [U("shield")] } };
  assert.deepEqual(resolveSelection(buildTree(LEGACY), null, sel, ctx(true)).errors, []);
  assert.equal(resolveSelection(buildTree(LEGACY), null, sel, ctx(false)).errors[0].code, E.NOT_PROFICIENT);
});

test("rejects missing, invalid and unreachable choices", () => {
  const tree = buildTree(LEGACY);
  const codes = sel => resolveSelection(tree, null, sel, ctx()).errors.map(x => x.code);
  assert.ok(codes({ choices: { or2: "b2" }, picks: { b2: MARTIAL } }).includes(E.MISSING_CHOICE));
  assert.ok(codes({ choices: { or1: "k1", or2: "b2" }, picks: { b2: MARTIAL } }).includes(E.INVALID_CHOICE));
  // Picks for the unchosen branch (b1x) are tampering.
  assert.ok(codes({ choices: { or1: "a1", or2: "b2" }, picks: { b2: MARTIAL, b1x: [MARTIAL[0]] } })
    .includes(E.UNEXPECTED_SELECTION));
});

test("rejects wrong pick counts and items outside the category", () => {
  const tree = buildTree(LEGACY);
  const codes = picks => resolveSelection(tree, null, { choices: { or1: "a1", or2: "b2" }, picks }, ctx())
    .errors.map(x => x.code);
  assert.deepEqual(codes({ b2: [MARTIAL[0]] }), [E.WRONG_PICK_COUNT]);
  assert.deepEqual(codes({ b2: [MARTIAL[0], U("dagger")] }), [E.NOT_IN_CATEGORY]);
});

test("modern package: items plus package currency", () => {
  const r = resolveSelection(buildTree(MODERN), "50", { choices: {}, picks: { p2: [U("smith")] } }, ctx());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.currency, { gp: 8 });
  assert.deepEqual(r.items.map(i => i.uuid), [U("staff"), U("smith")]);
});

test("modern wealth: the flat amount instead of the package", () => {
  const r = resolveSelection(buildTree(MODERN), "50", { mode: "wealth" }, ctx());
  assert.deepEqual([r.items, r.currency, r.errors], [[], { gp: 50 }, []]);
});

test("legacy wealth: a rolled total must lie in the formula's range", () => {
  const tree = buildTree(LEGACY);
  assert.deepEqual(resolveSelection(tree, "5d4 * 10", { mode: "wealth", wealth: { total: 120 } }).currency, { gp: 120 });
  assert.equal(resolveSelection(tree, "5d4 * 10", { mode: "wealth", wealth: { total: 999 } }).errors[0].code,
    E.WEALTH_OUT_OF_RANGE);
  assert.equal(resolveSelection(tree, null, { mode: "wealth" }).errors[0].code, E.NO_WEALTH_OPTION);
  assert.equal(resolveSelection(tree, "5d4", { mode: "wealth", wealth: { total: 12 }, choices: { or1: "a1" } })
    .errors[0].code, E.UNEXPECTED_SELECTION);
});

test("wealthOption parses the SRD shapes", () => {
  assert.deepEqual(wealthOption("155"), { fixed: 155 });
  assert.deepEqual(wealthOption("5d4 * 10"), { formula: "5d4 * 10", min: 50, max: 200 });
  assert.deepEqual(wealthOption("5d4"), { formula: "5d4", min: 5, max: 20 });
  assert.equal(wealthOption(""), null);
  assert.deepEqual(wealthOption("2d6 + 3"), { formula: "2d6 + 3" });
});

test("unknown entry types are reported, never skipped", () => {
  const r = resolveSelection(buildTree([...MODERN, e("z", "mystery", "p")]), null, { picks: { p2: [U("smith")] } }, ctx());
  assert.ok(r.errors.some(x => x.code === E.UNKNOWN_ENTRY_TYPE && x.entryId === "z"));
});

test("defaultSelection skips an 'if proficient' option the character can't use", () => {
  const tree = buildTree(LEGACY);
  const candidates = node => ({ martialM: MARTIAL, shield: [U("shield")] })[node.key] ?? [];
  const reordered = buildTree(LEGACY.map(x => (x._id === "a2" ? { ...x, sort: 0 } : x)));
  assert.equal(defaultSelection(reordered, { candidates, isProficient: () => false }).choices.or1, "a1");
  const sel = defaultSelection(tree, { candidates });
  assert.deepEqual(resolveSelection(tree, null, sel, ctx()).errors, []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, resolveSelection, listDecisions, defaultSelection, wealthOption, addCurrency }
  from "../scripts/rules/equipment.mjs";

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
const ctx = (proficient = true, extra = {}) => ({
  inCategory: (node, uuid) => ({ martialM: MARTIAL, shield: [U("shield")], art: [U("smith")] })[node.key]?.includes(uuid) ?? false,
  isProficient: () => proficient,
  ...extra
});
const codes = r => r.errors.map(x => x.code);

test("builds a tree from flat entries; top-level group may be '' or null", () => {
  const tree = buildTree([...LEGACY.slice(0, 3), { ...LEGACY[3], group: null }]);
  assert.deepEqual(tree.children.map(n => n._id), ["or1", "or2"]);
  assert.deepEqual(tree.children[0].children.map(n => n._id), ["a1", "a2"]);
});

test("lists only reachable decisions", () => {
  const tree = buildTree(LEGACY);
  assert.deepEqual(listDecisions(tree).map(d => d.id), ["or1", "or2"]);
  assert.deepEqual(listDecisions(tree, { or2: "b2" }).at(-1), { id: "b2", kind: "category", type: "weapon", key: "martialM", count: 2 });
});

test("resolves a full legacy selection into merged items", () => {
  const sel = { mode: "items", choices: { or1: "a1", or2: "b2" }, picks: { b2: [MARTIAL[0], MARTIAL[0]] } };
  const r = resolveSelection(buildTree(LEGACY), "5d4 * 10", sel, ctx());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.items.map(i => [i.uuid, i.count]), [[U("mace"), 1], [MARTIAL[0], 2], [U("pack"), 1], [U("arrow"), 20]]);
});

test("errors are contract errors (step 'equipment') naming the entry", () => {
  const r = resolveSelection(buildTree(LEGACY), null, { choices: { or2: "b2" }, picks: { b2: MARTIAL } }, ctx());
  assert.deepEqual(codes(r), ["MISSING_CHOICE"]);
  assert.equal(r.errors[0].step, "equipment");
  assert.equal(r.errors[0].key, "CHARCREATOR.Error.MISSING_CHOICE");
  assert.equal(r.errors[0].detail.entryId, "or1");
});

test("an 'if proficient' option needs proficiency", () => {
  const sel = { choices: { or1: "a2", or2: "b1" }, picks: { b1x: [MARTIAL[1]], b1y: [U("shield")] } };
  assert.deepEqual(resolveSelection(buildTree(LEGACY), null, sel, ctx(true)).errors, []);
  assert.deepEqual(codes(resolveSelection(buildTree(LEGACY), null, sel, ctx(false))), ["NOT_PROFICIENT"]);
});

test("a linked item the catalog doesn't allow is an invalid choice", () => {
  const sel = { choices: { or1: "a1", or2: "b2" }, picks: { b2: MARTIAL } };
  const r = resolveSelection(buildTree(LEGACY), null, sel, ctx(true, { isAllowed: u => u !== U("mace") }));
  assert.deepEqual(codes(r), ["INVALID_CHOICE"]);
  assert.equal(r.errors[0].detail.entryId, "a1");
});

test("rejects missing, invalid and unreachable choices", () => {
  const tree = buildTree(LEGACY);
  const c = sel => codes(resolveSelection(tree, null, sel, ctx()));
  assert.ok(c({ choices: { or2: "b2" }, picks: { b2: MARTIAL } }).includes("MISSING_CHOICE"));
  assert.ok(c({ choices: { or1: "k1", or2: "b2" }, picks: { b2: MARTIAL } }).includes("INVALID_CHOICE"));
  // Picks for the unchosen branch (b1x) are tampering; so are made-up ids.
  assert.ok(c({ choices: { or1: "a1", or2: "b2" }, picks: { b2: MARTIAL, b1x: [MARTIAL[0]] } }).includes("UNEXPECTED_SELECTION"));
  assert.ok(c({ choices: { or1: "a1", or2: "b2", zz: "a1" }, picks: { b2: MARTIAL } }).includes("UNEXPECTED_SELECTION"));
});

test("rejects wrong pick counts and items outside the category", () => {
  const tree = buildTree(LEGACY);
  const c = picks => codes(resolveSelection(tree, null, { choices: { or1: "a1", or2: "b2" }, picks }, ctx()));
  assert.deepEqual(c({ b2: [MARTIAL[0]] }), ["WRONG_PICK_COUNT"]);
  assert.deepEqual(c({ b2: [MARTIAL[0], MARTIAL[0], MARTIAL[1]] }), ["WRONG_PICK_COUNT"]);
  assert.deepEqual(c({ b2: [MARTIAL[0], U("dagger")] }), ["NOT_IN_CATEGORY"]);
});

test("modern package: items plus package currency", () => {
  const r = resolveSelection(buildTree(MODERN), "50", { choices: {}, picks: { p2: [U("smith")] } }, ctx());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.currency, { gp: 8 });
  assert.deepEqual(r.items.map(i => i.uuid), [U("staff"), U("smith")]);
});

test("modern wealth: the flat amount instead of the package", () => {
  const r = resolveSelection(buildTree(MODERN), "50", { mode: "wealth", choices: {}, picks: {} }, ctx());
  assert.deepEqual([r.items, r.currency, r.errors], [[], { gp: 50 }, []]);
});

test("legacy wealth: a rolled total must lie in the formula's range", () => {
  const tree = buildTree(LEGACY);
  assert.deepEqual(resolveSelection(tree, "5d4 * 10", { mode: "wealth", wealth: { total: 120 } }).currency, { gp: 120 });
  for ( const total of [999, 40, 120.5, "120", undefined] ) {
    assert.deepEqual(codes(resolveSelection(tree, "5d4 * 10", { mode: "wealth", wealth: { total } })), ["WEALTH_OUT_OF_RANGE"], String(total));
  }
  assert.deepEqual(codes(resolveSelection(tree, "2d6 + 3", { mode: "wealth", wealth: { total: 10 } })), ["WEALTH_OUT_OF_RANGE"]);
  assert.deepEqual(codes(resolveSelection(tree, null, { mode: "wealth" })), ["NO_WEALTH_OPTION"]);
  assert.deepEqual(codes(resolveSelection(tree, "5d4", { mode: "wealth", wealth: { total: 12 }, choices: { or1: "a1" } })), ["UNEXPECTED_SELECTION"]);
});

test("a bad mode, or wealth data in items mode, is rejected", () => {
  assert.deepEqual(codes(resolveSelection(buildTree(MODERN), "50", { mode: "shop" })), ["BAD_MODE"]);
  const sel = { mode: "items", choices: {}, picks: { p2: [U("smith")] }, wealth: { total: 50 } };
  assert.deepEqual(codes(resolveSelection(buildTree(MODERN), "50", sel, ctx())), ["UNEXPECTED_SELECTION"]);
});

test("wealthOption parses the SRD shapes", () => {
  assert.deepEqual(wealthOption("155"), { fixed: 155 });
  assert.deepEqual(wealthOption("5d4 * 10"), { formula: "5d4 * 10", number: 5, faces: 4, multiplier: 10, min: 50, max: 200 });
  assert.deepEqual(wealthOption("5d4"), { formula: "5d4", number: 5, faces: 4, multiplier: 1, min: 5, max: 20 });
  assert.equal(wealthOption(""), null);
  assert.equal(wealthOption(null), null);
  assert.deepEqual(wealthOption("2d6 + 3"), { formula: "2d6 + 3" });
});

test("unknown entry types are reported, never skipped", () => {
  const r = resolveSelection(buildTree([...MODERN, e("z", "mystery", "p")]), null, { picks: { p2: [U("smith")] } }, ctx());
  assert.ok(r.errors.some(x => x.code === "UNKNOWN_ENTRY_TYPE" && x.detail.entryId === "z"));
});

test("defaultSelection skips options the character can't use, and resolves cleanly", () => {
  const tree = buildTree(LEGACY);
  const candidates = node => ({ martialM: MARTIAL, shield: [U("shield")] })[node.key] ?? [];
  const reordered = buildTree(LEGACY.map(x => (x._id === "a2" ? { ...x, sort: 0 } : x)));
  assert.equal(defaultSelection(reordered, { candidates, isProficient: () => false }).choices.or1, "a1");
  assert.equal(defaultSelection(tree, { candidates, isAllowed: u => u !== U("mace") }).choices.or1, "a2");
  const sel = defaultSelection(tree, { candidates });
  assert.deepEqual(resolveSelection(tree, null, sel, ctx()).errors, []);
});

test("addCurrency sums into a total", () => {
  assert.deepEqual(addCurrency(addCurrency({}, { gp: 8 }), { gp: 15, sp: 3 }), { gp: 23, sp: 3 });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { requirements, validateSpells, spellStates, defaultSpells, normalizeSelection } from "../scripts/rules/spells.mjs";

// Synthetic class facts shaped like spell-facts.mjs output (no rules content).
const fullSlots = { spell1: 2, pact: 0, pactLevel: 0 };
const PREPARED = { identifier: "priest", type: "spell", preparation: { formula: "@x", max: 3 },
  scale: { "cantrips-known": 2 }, slots: fullSlots };
const KNOWN = { identifier: "caller", type: "spell", preparation: { formula: "", max: 0 },
  scale: { "cantrips-known": 1, "spells-known": 2 }, slots: fullSlots };
const PACT = { identifier: "pactmaker", type: "pact", preparation: { formula: "@y", max: 2 },
  scale: { "cantrips-known": 2 }, slots: { spell1: 0, pact: 1, pactLevel: 1 } };
const LATE = { identifier: "knightly", type: "spell", preparation: { formula: "@z", max: 2 }, scale: {},
  slots: { spell1: 0, pact: 0, pactLevel: 0 } };
const BOOK = { identifier: "wizard", type: "spell", preparation: { formula: "@w", max: 3 },
  scale: { "cantrips-known": 1 }, slots: fullSlots };
const NONE = { identifier: "brute", scale: {}, preparation: { formula: "" }, slots: { spell1: 0, pact: 0 } };

const U = n => `Compendium.test.spells.Item.${n.padEnd(16, "0")}`;
const C = [U("c1"), U("c2"), U("c3")];
const L1 = [U("a"), U("b"), U("c"), U("d"), U("e"), U("f"), U("g")];
const L2 = U("high");
const OFF = U("offlist");
const list = new Set([...C, ...L1, L2]);
const levels = new Map([...C.map(u => [u, 0]), ...L1.map(u => [u, 1]), [L2, 2], [OFF, 1]]);
const ctx = (extra = {}) => ({ list, levels, ...extra });
const codes = errs => errs.map(e => e.code);

test("requirements come from the class data", () => {
  assert.deepEqual(requirements(PREPARED), { caster: true, method: "spell", mode: "prepared", cantrips: 2, spells: 3, spellbook: 0, maxLevel: 1 });
  assert.equal(requirements(KNOWN).mode, "known");
  assert.equal(requirements(KNOWN).spells, 2);
  assert.deepEqual([requirements(PACT).method, requirements(PACT).spells, requirements(PACT).maxLevel], ["pact", 2, 1]);
  // A scale value turned into a number by an Active Effect (spike 1.9) counts the same.
  assert.equal(requirements({ ...PREPARED, scale: { "cantrips-known": 3 } }).cantrips, 3);
});

test("no slots at level 1 means no leveled spells, whatever the formula says (2014 half-casters)", () => {
  assert.deepEqual([requirements(LATE).caster, requirements(LATE).mode, requirements(LATE).spells], [false, "none", 0]);
  assert.equal(requirements(NONE).caster, false);
});

test("the Wizard spellbook comes from the rules table", () => {
  assert.equal(requirements(BOOK).spellbook, 6);
  assert.equal(requirements(PREPARED).spellbook, 0);
});

test("a legal prepared selection passes; prepared may be fewer than the maximum", () => {
  const req = requirements(PREPARED);
  assert.deepEqual(validateSpells(req, { cantrips: C.slice(0, 2), spells: L1.slice(0, 3) }, ctx()), []);
  assert.deepEqual(validateSpells(req, { cantrips: C.slice(0, 2), spells: L1.slice(0, 1) }, ctx()), []);
});

test("errors are contract errors for the spells step", () => {
  const [err] = validateSpells(requirements(PREPARED), { cantrips: C, spells: [] }, ctx());
  assert.deepEqual([err.code, err.step, err.detail], ["CANTRIP_COUNT", "spells", { chosen: 3, needed: 2 }]);
});

test("known spells must be exactly the number known", () => {
  const req = requirements(KNOWN);
  const c = s => codes(validateSpells(req, { cantrips: [C[0]], spells: s }, ctx()));
  assert.deepEqual(c(L1.slice(0, 2)), []);
  assert.deepEqual(c(L1.slice(0, 1)), ["SPELL_COUNT"]);
  assert.deepEqual(c(L1.slice(0, 3)), ["SPELL_COUNT"]);
});

test("tamper cases: counts, list, level, duplicates, non-casters", () => {
  const req = requirements(PREPARED);
  const c = sel => codes(validateSpells(req, sel, ctx()));
  assert.ok(c({ cantrips: C, spells: [] }).includes("CANTRIP_COUNT"));
  assert.ok(c({ cantrips: C.slice(0, 2), spells: L1.slice(0, 4) }).includes("SPELL_COUNT"));
  assert.ok(c({ cantrips: C.slice(0, 2), spells: [OFF] }).includes("NOT_ON_LIST"));
  assert.ok(c({ cantrips: C.slice(0, 2), spells: [L2] }).includes("WRONG_LEVEL"));
  assert.ok(c({ cantrips: [C[0], L1[0]], spells: [] }).includes("WRONG_LEVEL"));
  assert.ok(c({ cantrips: [C[0], C[0]], spells: [] }).includes("DUPLICATE"));
  assert.deepEqual(codes(validateSpells(requirements(NONE), { cantrips: [C[0]] }, ctx())), ["NOT_A_CASTER"]);
  assert.deepEqual(codes(validateSpells(requirements(LATE), { spells: [L1[0]] }, ctx())), ["NOT_A_CASTER"]);
  assert.deepEqual(validateSpells(requirements(NONE), {}, ctx()), []);
});

test("a spell the character already has from another source is rejected", () => {
  const req = requirements(PREPARED);
  const errs = validateSpells(req, { cantrips: C.slice(0, 2), spells: [L1[0]] }, ctx({ owned: new Set([C[1]]) }));
  assert.deepEqual(codes(errs), ["ALREADY_KNOWN"]);
  assert.deepEqual(errs[0].detail, [C[1]]);
});

test("the 2014 short UUID form is normalised before checking", () => {
  const short = u => u.replace(".Item.", ".");
  const req = requirements(PREPARED);
  assert.deepEqual(validateSpells(req, { cantrips: C.slice(0, 2).map(short), spells: [short(L1[0])] }, ctx()), []);
  assert.deepEqual(normalizeSelection({ cantrips: [short(C[0])] }), { cantrips: [C[0]], spells: [], spellbook: [] });
});

test("spellbook: exactly six, and prepared spells must come from it", () => {
  const req = requirements(BOOK);
  const book = L1.slice(0, 6);
  assert.deepEqual(validateSpells(req, { cantrips: [C[0]], spellbook: book, spells: book.slice(0, 3) }, ctx()), []);
  const c = sel => codes(validateSpells(req, sel, ctx()));
  assert.ok(c({ cantrips: [C[0]], spellbook: book.slice(0, 5), spells: [] }).includes("SPELLBOOK_COUNT"));
  assert.ok(c({ cantrips: [C[0]], spellbook: book, spells: [L1[6]] }).includes("NOT_IN_SPELLBOOK"));
  assert.ok(codes(validateSpells(requirements(PREPARED), { cantrips: C.slice(0, 2), spellbook: [L1[0]] }, ctx())).includes("SPELLBOOK_COUNT"));
});

test("stored states: cantrips 1, prepared 1, known 2 (always), unprepared spellbook 0", () => {
  const book = L1.slice(0, 6);
  const states = spellStates(requirements(BOOK), { cantrips: [C[0]], spellbook: book, spells: [book[0]] });
  assert.deepEqual(states.map(s => s.prepared), [1, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(spellStates(requirements(KNOWN), { spells: [L1[0]] }).map(s => s.prepared), [2]);
  assert.deepEqual(spellStates(requirements(PREPARED), { spells: [L1[0]] }).map(s => s.prepared), [1]);
});

test("defaultSpells picks legal spells, skipping owned ones", () => {
  const options = { cantrips: C, level1: L1 };
  for ( const facts of [PREPARED, KNOWN, PACT, BOOK, LATE, NONE] ) {
    const req = requirements(facts);
    assert.deepEqual(validateSpells(req, defaultSpells(req, options), ctx()), [], facts.identifier);
  }
  const owned = new Set([C[0]]);
  const sel = defaultSpells(requirements(PREPARED), options, owned);
  assert.deepEqual(sel.cantrips, [C[1], C[2]]);
  assert.deepEqual(validateSpells(requirements(PREPARED), sel, ctx({ owned })), []);
});

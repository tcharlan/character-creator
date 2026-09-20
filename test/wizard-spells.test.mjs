import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraft, checkDraftShape } from "../scripts/contracts.mjs";
import { requirements, validateSpells } from "../scripts/rules/spells.mjs";
import { spellsModel, toggleSpell, tabsFor } from "../scripts/wizard/spells-step.mjs";

const ID = n => String(n).padEnd(16, "0");
const U = n => `Compendium.test.spells.Item.${ID(n)}`;
const C = [U("c1"), U("c2"), U("c3"), U("c4")];
const L1 = [U("a"), U("b"), U("c"), U("d"), U("e"), U("f"), U("g")];
const catalog = { get: uuid => ({ name: `Spell ${uuid.slice(-4, -1)}`, img: "icon.webp" }) };
const options = { cantrips: C, level1: L1, list: new Set([...C, ...L1]), levels: new Map() };

const WIZARD = { identifier: "wizard", type: "spell", preparation: { formula: "@w", max: 3 },
  scale: { "cantrips-known": 2 }, slots: { spell1: 2, pact: 0, pactLevel: 0 } };
const KNOWN = { identifier: "bard", type: "spell", preparation: { formula: "", max: 0 },
  scale: { "cantrips-known": 2, "spells-known": 2 }, slots: { spell1: 2, pact: 0, pactLevel: 0 } };
const NONE = { identifier: "fighter", scale: {}, preparation: { formula: "" }, slots: { spell1: 0, pact: 0 } };

const draft = spells => {
  const d = createDraft({ id: ID("d"), worldId: "w", rules: "legacy", now: 1 });
  if ( spells ) d.spells = spells;
  return d;
};
const ctx = (facts, owned = new Set()) => ({ req: requirements(facts), options, owned });

test("the lists a class fills in depend on its shape", () => {
  assert.deepEqual(tabsFor(requirements(WIZARD)).map(t => [t.key, t.needed]), [["cantrips", 2], ["spellbook", 6], ["spells", 3]]);
  assert.deepEqual(tabsFor(requirements(KNOWN)).map(t => [t.key, t.needed]), [["cantrips", 2], ["spells", 2]]);
  assert.deepEqual(tabsFor(requirements(NONE)), []);
});

test("a non-caster is told there's nothing to choose", () => {
  const model = spellsModel(ctx(NONE), draft(), null, catalog);
  assert.equal(model.caster, false);
  assert.deepEqual(model.tabs, []);
  assert.equal(model.open, null);
  assert.equal(model.complete, true, "nothing to do is complete");
});

test("cantrips: pick up to the count, and the rest go out of reach", () => {
  const d = draft();
  const req = requirements(KNOWN);
  assert.ok(toggleSpell(d, "cantrips", C[0], req));
  assert.ok(toggleSpell(d, "cantrips", C[1], req));
  assert.deepEqual(d.spells.cantrips, [C[0], C[1]]);
  assert.equal(toggleSpell(d, "cantrips", C[2], req), null, "no room for a third");
  const model = spellsModel(ctx(KNOWN), d, "cantrips", catalog);
  const tab = model.tabs.find(t => t.key === "cantrips");
  assert.deepEqual([tab.chosen, tab.needed, tab.complete], [2, 2, true]);
  assert.deepEqual(model.open.list.filter(s => s.selected).map(s => s.uuid).sort(), [C[0], C[1]].sort());
  assert.deepEqual(model.open.list.filter(s => s.disabled).map(s => s.uuid).sort(), [C[2], C[3]].sort());
  assert.ok(toggleSpell(d, "cantrips", C[0], req), "clicking again frees it");
  assert.deepEqual(d.spells.cantrips, [C[1]]);
  assert.deepEqual(checkDraftShape(d), []);
});

test("a spell the character already has can't be picked again", () => {
  const owned = new Set([C[0]]);
  const d = draft();
  assert.equal(toggleSpell(d, "cantrips", C[0], requirements(KNOWN), owned), null);
  const model = spellsModel(ctx(KNOWN, owned), d, "cantrips", catalog);
  const already = model.open.list.find(s => s.uuid === C[0]);
  assert.deepEqual([already.already, already.disabled], [true, true]);
  assert.equal(model.known.length, 1, "it's listed as already known");
});

test("a spellbook class prepares only from its book", () => {
  const d = draft();
  const req = requirements(WIZARD);
  assert.equal(toggleSpell(d, "spells", L1[0], req), null, "not in the book yet");
  for ( const u of L1.slice(0, 6) ) toggleSpell(d, "spellbook", u, req);
  assert.equal(d.spells.spellbook.length, 6);
  assert.equal(toggleSpell(d, "spellbook", L1[6], req), null, "the book holds six");
  assert.ok(toggleSpell(d, "spells", L1[0], req), "now it can be prepared");
  const model = spellsModel(ctx(WIZARD), d, "spells", catalog);
  assert.deepEqual(model.open.list.map(s => s.uuid).sort(), L1.slice(0, 6).sort(), "only the book is offered");
  // Removing a spell from the book unprepares it.
  toggleSpell(d, "spellbook", L1[0], req);
  assert.deepEqual(d.spells.spells, []);
  assert.equal(d.spells.spellbook.length, 5);
  assert.deepEqual(checkDraftShape(d), []);
});

test("the open list is the first one that isn't finished, and a full selection validates", () => {
  const d = draft();
  const req = requirements(WIZARD);
  assert.equal(spellsModel(ctx(WIZARD), d, null, catalog).open.key, "cantrips");
  toggleSpell(d, "cantrips", C[0], req);
  toggleSpell(d, "cantrips", C[1], req);
  assert.equal(spellsModel(ctx(WIZARD), d, null, catalog).open.key, "spellbook");
  for ( const u of L1.slice(0, 6) ) toggleSpell(d, "spellbook", u, req);
  assert.equal(spellsModel(ctx(WIZARD), d, null, catalog).open.key, "spells");
  for ( const u of L1.slice(0, 3) ) toggleSpell(d, "spells", u, req);
  const model = spellsModel(ctx(WIZARD), d, null, catalog);
  assert.equal(model.complete, true);
  const levels = new Map([...C.map(u => [u, 0]), ...L1.map(u => [u, 1])]);
  assert.deepEqual(validateSpells(req, d.spells, { list: options.list, levels }), []);
});

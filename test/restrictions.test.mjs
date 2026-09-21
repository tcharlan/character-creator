import { test } from "node:test";
import assert from "node:assert/strict";
import { editorState, toStored, toggleEntry, allowAll, allowNone, allowOnly, togglePack, toggleMethod,
  isEntryAllowed, warnings, restrictionsModel, TABS } from "../scripts/settings/restrictions-model.mjs";
import { NO_RESTRICTIONS } from "../scripts/catalog/filters.mjs";
import { ABILITY_METHODS } from "../scripts/contracts.mjs";

const ID = n => String(n).padEnd(16, "0");
const U = n => `Compendium.dnd5e.classes.Item.${ID(n)}`;
const entry = n => ({ uuid: U(n), name: `Item ${n}`, img: "icon.webp", pack: "dnd5e.classes" });
const EVERYTHING = {
  species: [entry("elf"), entry("dwarf"), entry("human")],
  class: [entry("fighter"), entry("wizard")],
  background: [entry("acolyte")],
  subclass: [], feat: [], spell: [], equipment: []
};
const PACKS = [{ collection: "dnd5e.classes", label: "Classes" }, { collection: "dnd5e.spells", label: "Spells" }];
const state = () => editorState(NO_RESTRICTIONS, ABILITY_METHODS);

test("an unrestricted world stores nothing", () => {
  const s = state();
  assert.deepEqual(toStored(s), { packs: null, categories: {} });
  assert.equal(isEntryAllowed(s, "class", U("fighter")), true, "no list means everything");
  assert.deepEqual(s.abilityMethods, [...ABILITY_METHODS]);
});

test("turning one entry off writes the rest down; turning it back on forgets the list", () => {
  const all = EVERYTHING.class.map(e => e.uuid);
  let s = toggleEntry(state(), "class", U("wizard"), all);
  assert.deepEqual(s.categories.class, [U("fighter")], "the others become the list");
  assert.equal(isEntryAllowed(s, "class", U("wizard")), false);
  assert.deepEqual(toStored(s).categories, { class: [U("fighter")] }, "only the restricted category is stored");
  s = toggleEntry(s, "class", U("wizard"), all);
  assert.equal(s.categories.class, null, "everything allowed again: back to no restriction");
  assert.deepEqual(toStored(s), { packs: null, categories: {} });
});

test("allow all, none, or only what's on screen", () => {
  const all = EVERYTHING.species.map(e => e.uuid);
  assert.equal(allowAll(allowNone(state(), "species"), "species").categories.species, null);
  assert.deepEqual(allowNone(state(), "species").categories.species, []);
  const only = allowOnly(state(), "species", [U("elf"), U("dwarf")]);
  assert.deepEqual(only.categories.species, [U("elf"), U("dwarf")]);
  assert.equal(isEntryAllowed(only, "species", U("human")), false);
  // A list that covers everything is the same as no restriction the next time an entry is toggled.
  const covered = toggleEntry(toggleEntry(only, "species", U("human"), all), "species", U("elf"), all);
  assert.deepEqual(covered.categories.species, [U("dwarf"), U("human")]);
});

test("packs narrow the same way; the last ability method can't be turned off", () => {
  const collections = PACKS.map(p => p.collection);
  let s = togglePack(state(), "dnd5e.spells", collections);
  assert.deepEqual(s.packs, ["dnd5e.classes"]);
  s = togglePack(s, "dnd5e.spells", collections);
  assert.equal(s.packs, null);

  let m = toggleMethod(state(), "rolled");
  assert.deepEqual(m.abilityMethods, ["pointBuy", "standardArray"]);
  m = toggleMethod(m, "pointBuy");
  assert.deepEqual(m.abilityMethods, ["standardArray"]);
  m = toggleMethod(m, "standardArray");
  assert.deepEqual(m.abilityMethods, ["standardArray"], "there has to be a way to set scores");
  assert.deepEqual(toggleMethod(m, "nonsense").abilityMethods, ["standardArray"]);
});

test("the GM is told what their choices mean", () => {
  // This world has a single background (as the 2014 SRD does), which the creator picks for the player (D4).
  assert.deepEqual(warnings(state(), EVERYTHING).map(w => [w.key, w.category]), [["OnlyOne", "background"]]);
  assert.deepEqual(warnings(state(), { ...EVERYTHING, background: [] }), [], "a category this world has none of");
  const none = allowNone(state(), "class");
  assert.deepEqual(warnings(none, { ...EVERYTHING, background: [] }).map(w => [w.key, w.category, w.level]),
    [["NoneRequired", "class", "problem"]]);
  const one = allowOnly(state(), "class", [U("fighter")]);
  assert.deepEqual(warnings(one, { ...EVERYTHING, background: [] }).map(w => w.key), ["OnlyOne"],
    "one class is chosen for the player (D4)");
  const method = toggleMethod(toggleMethod(state(), "rolled"), "pointBuy");
  assert.deepEqual(warnings(method, { ...EVERYTHING, background: [] }).map(w => w.key), ["OneMethod"]);
});

test("the screen: a tab per category plus packs and ability scores", () => {
  const s = allowOnly(state(), "class", [U("fighter")]);
  const model = restrictionsModel({ state: s, everything: EVERYTHING, packs: PACKS, tab: "class" });
  assert.deepEqual(model.tabs.map(t => t.key), [...TABS]);
  const tab = key => model.tabs.find(t => t.key === key);
  assert.deepEqual([tab("class").allowed, tab("class").total, tab("class").restricted], [1, 2, true]);
  assert.equal(tab("species").restricted, false);
  assert.equal(tab("packs").restricted, false);
  assert.deepEqual(model.category.entries.map(e => [e.name, e.allowed]), [["Item fighter", true], ["Item wizard", false]]);
  assert.equal(model.category.unrestricted, false);
  assert.deepEqual(model.warnings.map(w => w.category), ["background", "class"], "one background, one class");

  const searched = restrictionsModel({ state: s, everything: EVERYTHING, packs: PACKS, tab: "class", search: "wiz" });
  assert.deepEqual(searched.category.entries.map(e => e.name), ["Item wizard"]);
  assert.deepEqual([searched.category.shown, searched.category.total], [1, 2]);

  const packs = restrictionsModel({ state: s, everything: EVERYTHING, packs: PACKS, tab: "packs" });
  assert.deepEqual(packs.packs.entries.map(p => [p.collection, p.allowed]),
    [["dnd5e.classes", true], ["dnd5e.spells", true]]);
  const abilities = restrictionsModel({ state: s, everything: EVERYTHING, packs: PACKS, tab: "abilities" });
  assert.deepEqual(abilities.abilities.map(a => a.key), [...ABILITY_METHODS]);
  assert.equal(abilities.abilities.every(a => a.allowed), true);
  assert.equal(restrictionsModel({ state: s, everything: EVERYTHING, packs: PACKS, tab: "nonsense" }).open, TABS[0]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { optionList, subclassOptions, artFor, STEP_CATEGORY } from "../scripts/wizard/options-step.mjs";

const ID = n => String(n).padEnd(16, "0");
const U = n => `Compendium.dnd5e.races.Item.${ID(n)}`;
const SHORT = n => `Compendium.dnd5e.races.${ID(n)}`;   // the 2014 form, without "Item"
const entry = (n, over = {}) => ({ uuid: U(n), name: `Name ${n}`, img: `icons/${n}.webp`, ...over });
const catalog = {
  byCategory: {
    species: [entry("elf"), entry("dwarf"), entry("gnome")],
    subclass: [entry("life", { system: { classIdentifier: "cleric" } }),
      entry("war", { system: { classIdentifier: "cleric" } }),
      entry("evo", { system: { classIdentifier: "wizard" } })]
  }
};

test("the option list is the catalog's, sorted, searchable, and marks the pick", () => {
  const all = optionList(catalog, "species", {});
  assert.deepEqual(all.list.map(o => o.name), ["Name dwarf", "Name elf", "Name gnome"]);
  assert.deepEqual([all.total, all.searchable], [3, false], "a short list needs no search box");
  assert.equal(all.list[0].img, "icons/dwarf.webp");
  const chosen = optionList(catalog, "species", { selected: U("elf") });
  assert.deepEqual(chosen.list.filter(o => o.selected).map(o => o.name), ["Name elf"]);
  const found = optionList(catalog, "species", { search: " GNO " });
  assert.deepEqual(found.list.map(o => o.name), ["Name gnome"]);
  assert.deepEqual(optionList(null, "species", {}).list, []);
  assert.equal(STEP_CATEGORY.species, "species");
});

test("the GM's own picture is used where there is one (D24)", () => {
  const art = { [U("elf")]: "worlds/w/assets/elf.webp" };
  assert.equal(artFor(U("elf"), art, "icons/elf.webp"), "worlds/w/assets/elf.webp");
  assert.equal(artFor(SHORT("elf"), art, "icons/elf.webp"), "worlds/w/assets/elf.webp",
    "the short UUID form finds it too");
  assert.equal(artFor(U("dwarf"), art, "icons/dwarf.webp"), "icons/dwarf.webp", "otherwise the compendium's");
  assert.equal(artFor(U("dwarf"), art, null), null);
  assert.equal(artFor(U("dwarf"), {}, "icons/dwarf.webp"), "icons/dwarf.webp");
  assert.equal(artFor(U("dwarf"), undefined, "icons/dwarf.webp"), "icons/dwarf.webp");

  const list = optionList(catalog, "species", { art });
  assert.equal(list.list.find(o => o.name === "Name elf").img, "worlds/w/assets/elf.webp");
  assert.equal(list.list.find(o => o.name === "Name dwarf").img, "icons/dwarf.webp");
});

test("subclasses are the ones of that class, with the GM's pictures too", () => {
  const subs = subclassOptions(catalog, "cleric", U("life"));
  assert.deepEqual(subs.map(s => s.name), ["Name life", "Name war"]);
  assert.deepEqual(subs.map(s => s.selected), [true, false]);
  const art = { [U("war")]: "worlds/w/assets/war.webp" };
  assert.equal(subclassOptions(catalog, "cleric", null, art).find(s => s.name === "Name war").img,
    "worlds/w/assets/war.webp");
  assert.deepEqual(subclassOptions(catalog, "nobody", null), []);
});

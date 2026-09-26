import { test } from "node:test";
import assert from "node:assert/strict";
import { editorState, toStored, toStoredArt, toggleEntry, allowAll, allowNone, allowOnly, togglePack,
  toggleMethod, setArt, isEntryAllowed, warnings, restrictionsModel, TABS }
  from "../scripts/settings/restrictions-model.mjs";
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

test("a picture of the GM's own sits beside the option it belongs to (D24)", () => {
  const art = { [U("elf")]: "worlds/w/assets/elf.webp" };
  const s = editorState(NO_RESTRICTIONS, ABILITY_METHODS, art);
  assert.deepEqual(s.art, art);
  const model = restrictionsModel({ state: s, everything: EVERYTHING, packs: PACKS, tab: "species" });
  const elf = model.category.entries.find(e => e.uuid === U("elf"));
  assert.equal(elf.art, art[U("elf")]);
  assert.equal(elf.img, art[U("elf")], "the row shows the GM's picture, not the compendium's");
  const dwarf = model.category.entries.find(e => e.uuid === U("dwarf"));
  assert.equal(dwarf.art, null);
  assert.equal(dwarf.img, "icon.webp");

  setArt(s, U("dwarf"), "worlds/w/assets/dwarf.webp");
  assert.deepEqual(Object.keys(toStoredArt(s)).sort(), [U("dwarf"), U("elf")].sort());
  setArt(s, U("elf"), null);
  assert.deepEqual(Object.keys(toStoredArt(s)), [U("dwarf")], "clearing one takes it off again");
  assert.deepEqual(toStoredArt({}), {});
  assert.deepEqual(editorState(NO_RESTRICTIONS, ABILITY_METHODS).art, {}, "no pictures by default");
});

test("the Backgrounds tab lists every step with its emblem or the GM's picture (D28)", async () => {
  const { setStepArt, toStoredStepArt } = await import("../scripts/settings/restrictions-model.mjs");
  const { STEPS } = await import("../scripts/contracts.mjs");
  assert.ok(TABS.includes("backdrops"));
  const s = editorState(NO_RESTRICTIONS, ABILITY_METHODS, {}, { spells: "worlds/w/stars.webp" });
  setStepArt(s, "species", "worlds/w/hills.webp");
  setStepArt(s, "spells", null);
  setStepArt(s, "nonsense", "worlds/w/x.webp");
  assert.deepEqual(toStoredStepArt(s), { species: "worlds/w/hills.webp" });
  const model = restrictionsModel({ state: s, everything: EVERYTHING, packs: PACKS, tab: "backdrops" });
  assert.deepEqual(model.backdrops.map(b => b.step), [...STEPS]);
  const species = model.backdrops.find(b => b.step === "species");
  assert.deepEqual([species.own, species.img], ["worlds/w/hills.webp", "worlds/w/hills.webp"]);
  const spells = model.backdrops.find(b => b.step === "spells");
  assert.deepEqual([spells.own, spells.img], [null, "modules/character-creator/assets/splash/spells.svg"]);
  assert.equal(model.backdrops.find(b => b.step === "start").labelKey, "Nav.Start");
  assert.equal(model.tabs.find(t => t.key === "backdrops").restricted, true, "marked when the GM has set any");
});

/* Filtering a category by compendium, the source on each row, and the same option in two compendiums. */

const PHB = { collection: "dnd-phb.classes", label: "Player's Handbook (2024)" };
const TWO_PACKS = [...PACKS, PHB];
const phbEntry = (n, name) => ({ uuid: `Compendium.dnd-phb.classes.Item.${ID(n)}`, name, img: "phb.webp",
  pack: PHB.collection });
const BOTH = {
  ...EVERYTHING,
  class: [entry("fighter"), entry("wizard"), phbEntry("phbwiz", "Item wizard"), phbEntry("phbrog", "Rogue")]
};
const classModel = (s, options = {}) =>
  restrictionsModel({ state: s, everything: BOTH, packs: TWO_PACKS, tab: "class", ...options }).category;

test("a category can be narrowed to one compendium, and says how much of each is allowed", () => {
  const s = state();
  const all = classModel(s);
  assert.deepEqual(all.packs.map(p => [p.label, p.total, p.allowed]),
    [["Classes", 2, 2], ["Player's Handbook (2024)", 2, 2]]);
  assert.equal(all.filtered, false, "nothing is filtered to begin with");
  const onlyPhb = classModel(s, { pack: PHB.collection });
  assert.deepEqual(onlyPhb.entries.map(e => e.name), ["Item wizard", "Rogue"]);
  assert.deepEqual([onlyPhb.shown, onlyPhb.filtered, onlyPhb.pack], [2, true, PHB.collection]);
  assert.equal(classModel(s, { pack: "nonsense" }).shown, 4, "an unknown compendium isn't a filter");
});

test("allowing or disallowing what is shown leaves the rest of the category alone", async () => {
  const { allowThese, disallowThese } = await import("../scripts/settings/restrictions-model.mjs");
  const all = BOTH.class.map(e => e.uuid);
  const s = state();
  const phb = classModel(s, { pack: PHB.collection }).entries.map(e => e.uuid);
  disallowThese(s, "class", phb, all);
  assert.deepEqual(s.categories.class.sort(), [U("fighter"), U("wizard")].sort(), "only the other compendium is left");
  assert.equal(classModel(s).packs.find(p => p.collection === PHB.collection).allowed, 0);
  allowThese(s, "class", [phb[0]], all);
  assert.equal(s.categories.class.length, 3, "one of them back, the rest untouched");
  allowThese(s, "class", phb, all);
  assert.equal(s.categories.class, null, "everything allowed again stores nothing");
});

test("each option says which compendium it came from", () => {
  const rows = classModel(state()).entries;
  assert.deepEqual(rows.find(e => e.name === "Rogue").packLabel, PHB.label);
  assert.equal(rows.find(e => e.name === "Rogue").pack, PHB.collection, "the id is kept for the tooltip");
});

test("the same option in two compendiums is flagged, and can be filtered to", async () => {
  const { duplicatesOf } = await import("../scripts/settings/restrictions-model.mjs");
  assert.deepEqual([...duplicatesOf(BOTH.class).keys()], ["item wizard"], "by name, whatever the case");
  const s = state();
  const model = classModel(s);
  assert.equal(model.duplicates, 1);
  const wizards = model.entries.filter(e => e.duplicate);
  assert.equal(wizards.length, 2, "both copies are marked");
  assert.deepEqual(wizards[0].alsoIn, [PHB.label], "each says where the other one is");
  assert.equal(wizards.every(e => e.bothAllowed), true, "allowed twice: worth the GM's attention");
  assert.deepEqual(classModel(s, { onlyDuplicates: true }).entries.map(e => e.name), ["Item wizard", "Item wizard"]);

  // Allowing only one copy is a decision made: still marked, no longer a clash.
  toggleEntry(s, "class", wizards[1].uuid, BOTH.class.map(e => e.uuid));
  const after = classModel(s).entries.filter(e => e.duplicate);
  assert.equal(after.every(e => e.duplicate), true);
  assert.equal(after.some(e => e.bothAllowed), false, "one of each is not a clash");
});

test("two compendiums with the same label are told apart by where they came from", async () => {
  const { packNames } = await import("../scripts/settings/restrictions-model.mjs");
  const packs = [
    { collection: "dnd5e.origins24", label: "Character Origins", source: "Dungeons & Dragons Fifth Edition" },
    { collection: "dnd-players-handbook.origins", label: "Character Origins", source: "Player's Handbook (2024)" },
    { collection: "dnd5e.spells", label: "Spells (SRD)", source: "Dungeons & Dragons Fifth Edition" }
  ];
  const names = packNames(packs);
  assert.equal(names.get("dnd5e.origins24"), "Character Origins — Dungeons & Dragons Fifth Edition");
  assert.equal(names.get("dnd-players-handbook.origins"), "Character Origins — Player's Handbook (2024)");
  assert.equal(names.get("dnd5e.spells"), "Spells (SRD)", "a label of its own is left alone");
  assert.equal(packNames([{ collection: "a.b", label: "Same" }, { collection: "c.d", label: "Same" }]).get("a.b"),
    "Same", "with nowhere to point at, the label stands");
});

test("the compendium each option comes from is named the same way, in the list and the filter", () => {
  const packs = [
    { collection: "dnd5e.classes", label: "Classes", source: "Dungeons & Dragons Fifth Edition" },
    { collection: "dnd-phb.classes", label: "Classes", source: "Player's Handbook (2024)" }
  ];
  const everything = { ...EVERYTHING, class: [entry("fighter"),
    { uuid: `Compendium.dnd-phb.classes.Item.${ID("phbfig")}`, name: "Item fighter", img: "x.webp", pack: "dnd-phb.classes" }] };
  const model = restrictionsModel({ state: state(), everything, packs, tab: "class" }).category;
  assert.deepEqual(model.packs.map(p => p.label),
    ["Classes — Dungeons & Dragons Fifth Edition", "Classes — Player's Handbook (2024)"]);
  assert.deepEqual([...new Set(model.entries.map(e => e.packLabel))].sort(),
    ["Classes — Dungeons & Dragons Fifth Edition", "Classes — Player's Handbook (2024)"]);
});

test("the same name twice in one compendium is not a clash", async () => {
  const { duplicatesOf } = await import("../scripts/settings/restrictions-model.mjs");
  // dnd5e's 2024 classes each bring an "Epic Boon" of their own, all in the same compendium.
  const boons = Array.from({ length: 5 }, (_, i) => ({ uuid: U(`boon${i}`), name: "Epic Boon", pack: "dnd5e.classes24" }));
  assert.deepEqual([...duplicatesOf(boons).keys()], [], "one compendium, however many of them");
  const across = [...boons, { uuid: `Compendium.dnd-phb.feats.Item.${ID("phbboon")}`, name: "Epic Boon", pack: "dnd-phb.feats" }];
  assert.deepEqual([...duplicatesOf(across).keys()], ["epic boon"], "the same name in a second compendium is");
});

test("turning a compendium off takes its content with it, in the lists above", () => {
  const packs = [{ collection: "dnd5e.classes", label: "Classes" }, { collection: "extra.classes", label: "Extra" }];
  const extra = { uuid: `Compendium.extra.classes.Item.${ID("extrafig")}`, name: "Extra Fighter", img: "x.webp",
    pack: "extra.classes" };
  const everything = { ...EVERYTHING, class: [...EVERYTHING.class, extra] };
  const s = state();
  const model = () => restrictionsModel({ state: s, everything, packs, tab: "class" }).category;
  assert.equal(model().allowed, 3, "everything to begin with");

  togglePack(s, "extra.classes", packs.map(p => p.collection));
  const after = model();
  assert.equal(after.allowed, 2, "the extra compendium's class no longer counts as allowed");
  const row = after.entries.find(e => e.uuid === extra.uuid);
  assert.deepEqual([row.allowed, row.packOff], [false, true], "and its row says why");
  assert.equal(after.packs.find(p => p.collection === "extra.classes").allowed, 0);
  assert.equal(after.entries.find(e => e.name === "Item fighter").packOff, false, "the rest is untouched");
});

test("each row carries what it needs to be told apart on hover", () => {
  const packs = [{ collection: "dnd5e.classes", label: "Classes" }];
  const model = restrictionsModel({ state: state(), everything: EVERYTHING, packs, tab: "class" }).category;
  const row = model.entries[0];
  assert.equal(row.packLabel, "Classes");
  assert.equal(row.id, row.uuid.split(".").pop(), "the item's own id, so two of a name can be told apart");
});

test("a turned-off compendium shows in the tab count and stops 'everything is allowed'", () => {
  const packs = [{ collection: "dnd5e.classes", label: "Classes" }];
  const s = state();
  const before = restrictionsModel({ state: s, everything: EVERYTHING, packs, tab: "class" });
  assert.equal(before.category.unrestricted, true);
  assert.equal(before.tabs.find(t => t.key === "class").allowed, 2);

  togglePack(s, "dnd5e.classes", ["dnd5e.classes"]);
  const after = restrictionsModel({ state: s, everything: EVERYTHING, packs, tab: "class" });
  assert.equal(after.tabs.find(t => t.key === "class").allowed, 0, "0 / 2 in the sidebar");
  assert.equal(after.category.unrestricted, false, "and it no longer claims everything is allowed");
  assert.equal(after.category.allowed, 0);
});

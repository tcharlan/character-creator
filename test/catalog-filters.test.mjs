import { test } from "node:test";
import assert from "node:assert/strict";
import {
  categoryOf, matchesRules, packExclusion, entryExclusion, fixedReferences, buildCatalogData, isAllowed,
  shortfall, normalizeUuid, NO_RESTRICTIONS
} from "../scripts/catalog/filters.mjs";

// Synthetic packs and entries (structure like dnd5e's pack index; no rules content).
const ID = n => String(n).padEnd(16, "0");
const U = (pack, n) => `Compendium.test.${pack}.Item.${ID(n)}`;
const pack = (name, extra = {}) => ({ collection: `test.${name}`, documentName: "Item", visible: true, sourceEnabled: true, ...extra });
const entry = (p, n, type, rules = "", extra = {}) => ({ pack: `test.${p}`, uuid: U(p, n), name: n, type,
  system: { source: { rules }, ...extra } });

const PACKS = [pack("core"), pack("old"), pack("hidden", { visible: false }), pack("off", { sourceEnabled: false }),
  { collection: "test.journal", documentName: "JournalEntry", visible: true, sourceEnabled: true }];
const ENTRIES = [
  entry("core", "elf", "race", "2024"),
  entry("core", "sage", "background", "2024", {
    advancement: { a: { type: "ItemGrant", configuration: { items: [{ uuid: U("core", "feat") }] } } },
    startingEquipment: [{ type: "AND" }, { type: "linked", key: `Compendium.test.old.${ID("clothes")}` }]
  }),
  entry("core", "fighter", "class", "2024"),
  entry("core", "champion", "subclass", "2024"),
  entry("core", "feat", "feat", "2024", {
    advancement: { b: { type: "ItemGrant", configuration: { items: [{ uuid: U("hidden", "spell") }] } } }
  }),
  entry("core", "bolt", "spell", "2024"),
  entry("core", "sword", "weapon", ""),          // no edition: follows the world
  entry("core", "facility", "facility", "2024"),
  entry("old", "clothes", "equipment", "2014"),
  entry("old", "dwarf", "race", "2014"),
  entry("hidden", "spell", "spell", "2024"),
  entry("off", "orc", "race", "2024")
];
const lookup = uuid => ENTRIES.find(e => normalizeUuid(e.uuid) === normalizeUuid(uuid));
const build = (rules = "modern", restrictions = NO_RESTRICTIONS) =>
  buildCatalogData({ packs: PACKS, entries: ENTRIES, rules, restrictions, lookup });

test("categories by item type; unoffered types are null", () => {
  assert.deepEqual(["race", "background", "class", "subclass", "feat", "spell", "weapon", "tool", "container", "facility"]
    .map(type => categoryOf({ type })), ["species", "background", "class", "subclass", "feat", "spell", "equipment",
    "equipment", "equipment", null]);
});

test("monster features (feat items of type 'monster') are never offered", () => {
  assert.equal(categoryOf({ type: "feat", system: { type: { value: "monster" } } }), null);
  assert.equal(categoryOf({ type: "feat", system: { type: { value: "feat", subtype: "origin" } } }), "feat");
});

test("rules: 2014 ↔ legacy, 2024 ↔ modern, no edition follows the world", () => {
  assert.ok(matchesRules({ system: { source: { rules: "2014" } } }, "legacy"));
  assert.ok(!matchesRules({ system: { source: { rules: "2014" } } }, "modern"));
  assert.ok(matchesRules({ system: { source: { rules: "" } } }, "modern"));
  assert.ok(matchesRules({ system: {} }, "legacy"));
});

test("pack exclusions: not an Item pack, hidden, source-disabled, not in the GM's pack list", () => {
  assert.deepEqual(PACKS.map(p => packExclusion(p)), [null, null, "hidden", "sourceDisabled", "notItemPack"]);
  assert.equal(packExclusion(pack("old"), { packs: ["test.core"], categories: {} }), "packNotAllowed");
});

test("entry exclusions: category, rules, GM allowlist (UUID forms normalised)", () => {
  assert.equal(entryExclusion(entry("core", "facility", "facility"), "modern"), "noCategory");
  assert.equal(entryExclusion(entry("old", "dwarf", "race", "2014"), "modern"), "wrongRules");
  const r = { packs: null, categories: { species: [`Compendium.test.core.${ID("elf")}`] } };
  assert.equal(entryExclusion(entry("core", "elf", "race", "2024"), "modern", r), null);
  assert.equal(entryExclusion(entry("core", "orc", "race", "2024"), "modern", r), "notInAllowlist");
  assert.equal(entryExclusion(entry("core", "bolt", "spell", "2024"), "modern", r), null, "other categories unrestricted");
});

test("the modern catalog: right entries per category, with exclusion counts", () => {
  const c = build("modern");
  assert.deepEqual(c.byCategory.species.map(e => e.name), ["elf"]);
  assert.deepEqual(c.byCategory.equipment.map(e => e.name), ["sword"]);
  assert.deepEqual(c.byCategory.spell.map(e => e.name), ["bolt"]);
  assert.deepEqual(c.excluded, { noCategory: 1, wrongRules: 2, hidden: 1, sourceDisabled: 1 });
});

test("the legacy catalog of the same packs holds only 2014 and edition-less entries", () => {
  const c = build("legacy");
  assert.deepEqual(c.byCategory.species.map(e => e.name), ["dwarf"]);
  assert.deepEqual(c.byCategory.equipment.map(e => e.name).sort(), ["clothes", "sword"]);
  assert.equal(c.byCategory.class.length, 0);
});

test("fixed references: ItemGrant items and linked starting equipment", () => {
  const sage = ENTRIES.find(e => e.name === "sage");
  assert.deepEqual(fixedReferences(sage), [U("core", "feat"), U("old", "clothes")]);
});

test("granted by reference: a 2014 item linked by a 2024 background, and a hidden pack's granted spell", () => {
  const c = build("modern");
  assert.ok(!c.allowed.has(U("old", "clothes")));
  assert.ok(isAllowed(c, `Compendium.test.old.${ID("clothes")}`), "linked kit item across rules");
  assert.ok(isAllowed(c, U("hidden", "spell")), "granted by an allowed feat, transitively");
  assert.ok(!isAllowed(c, U("off", "orc")), "not referenced by anything allowed");
});

test("GM category allowlists narrow what's offered; references of excluded entries don't count", () => {
  const r = { packs: null, categories: { background: [] } };
  const c = build("modern", r);
  assert.equal(c.byCategory.background.length, 0);
  assert.ok(!isAllowed(c, U("old", "clothes")), "the background isn't allowed, so its kit isn't either");
  assert.ok(isAllowed(c, U("hidden", "spell")), "still granted by the allowed feat");
});

test("GM pack allowlist narrows to the listed packs", () => {
  const c = build("modern", { packs: ["test.core"], categories: {} });
  assert.equal(c.excluded.packNotAllowed, 2);
});

test("shortfall: enough, exact, or too few allowed options for a choice", () => {
  const c = build("modern", { packs: null, categories: { spell: [] } });
  const options = [U("core", "bolt"), U("hidden", "spell")];
  assert.deepEqual(shortfall(options, 1, build("modern")), { available: [U("core", "bolt")], needed: 1, short: false, exact: true });
  assert.equal(shortfall(options, 1, c).short, true, "spells restricted to none");
  assert.equal(shortfall([], 0, c).short, false);
});

test("fixed references read older and imported shapes of the index data, and never throw", () => {
  // The index is raw stored data: imported and older items can keep a list as an object (a user's world did).
  const grant = items => ({ system: { advancement: { a: { type: "ItemGrant", configuration: { items } } } } });
  const u1 = U("core", "feat");
  const u2 = U("old", "clothes");
  assert.deepEqual(fixedReferences(grant({ 0: { uuid: u1 }, 1: { uuid: u2 } })), [u1, u2], "array stored as an object");
  assert.deepEqual(fixedReferences(grant([u1, u2])), [u1, u2], "older list of UUID strings");
  assert.deepEqual(fixedReferences(grant({ [u1]: true, [u2]: false })), [u1], "keyed by UUID");
  assert.deepEqual(fixedReferences(grant("nonsense")), []);
  assert.deepEqual(fixedReferences(grant([{ uuid: 42 }, null, { optional: true }])), []);
  assert.deepEqual(fixedReferences({ system: { advancement: [{ type: "ItemGrant", configuration: { items: [{ uuid: u1 }] } }] } }),
    [u1], "advancement stored as an array");
  assert.deepEqual(fixedReferences({ system: { startingEquipment: { 0: { type: "linked", key: u2 }, 1: { type: "linked", key: 7 } } } }),
    [u2], "starting equipment stored as an object");
  assert.deepEqual(fixedReferences({ system: { advancement: 5, startingEquipment: "x" } }), []);
  assert.deepEqual(fixedReferences(null), []);
});

test("one oddly stored entry doesn't stop the catalog", () => {
  const odd = { ...ENTRIES.find(e => e.name === "sage"), uuid: U("core", "oddsage"), name: "odd sage",
    system: { ...ENTRIES.find(e => e.name === "sage").system,
      advancement: { a: { type: "ItemGrant", configuration: { items: { 0: { uuid: U("core", "feat") } } } } } } };
  assert.doesNotThrow(() => buildCatalogData({ packs: PACKS, entries: [...ENTRIES, odd], rules: "modern" }));
});

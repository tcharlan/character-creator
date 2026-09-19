import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraft, SCHEMA_VERSION } from "../scripts/contracts.mjs";
import { checkEnvelope, checkBuiltStructure, checkDetails, checkPortraitImage, checkCharacterLimit, errorsByStep }
  from "../scripts/rules/draft-checks.mjs";

const ID = n => String(n).padEnd(16, "0");
const U = n => `Compendium.test.items.Item.${ID(n)}`;
const WORLD = { worldId: "legacy-test", rules: "legacy" };
const draft = over => ({ ...createDraft({ id: ID("draft"), ...WORLD, now: 1 }), ...over });
const codes = errs => errs.map(e => e.code);

test("envelope: a well-formed draft for this world and rules passes, migrated", () => {
  const { draft: d, errors } = checkEnvelope(draft(), WORLD);
  assert.deepEqual(errors, []);
  assert.equal(d.schema, SCHEMA_VERSION);
});

test("envelope: bad shape, newer schema, no schema, other world, other rules", () => {
  assert.deepEqual(codes(checkEnvelope(draft({ picks: "nope" }), WORLD).errors), ["BAD_REQUEST"]);
  assert.ok(checkEnvelope(draft({ picks: "nope" }), WORLD).errors[0].detail.problems.length);
  assert.deepEqual(codes(checkEnvelope(draft({ schema: SCHEMA_VERSION + 1 }), WORLD).errors), ["SCHEMA_TOO_NEW"]);
  assert.deepEqual(codes(checkEnvelope(draft({ schema: undefined }), WORLD).errors), ["BAD_REQUEST"]);
  assert.deepEqual(codes(checkEnvelope(null, WORLD).errors), ["BAD_REQUEST"]);
  assert.deepEqual(codes(checkEnvelope(draft({ worldId: "elsewhere" }), WORLD).errors), ["WORLD_MISMATCH"]);
  assert.deepEqual(codes(checkEnvelope(draft({ rules: "modern" }), WORLD).errors), ["RULES_MISMATCH"]);
  assert.equal(checkEnvelope(draft({ rules: "modern" }), WORLD).draft, null);
});

/** A plain built-character summary: one of each root, a granted feature and a subclass. */
const item = (id, type, extra = {}) => ({ id: ID(id), name: id, type, source: U(id), origin: null, levels: null, ...extra });
const summary = over => ({
  level: 1, hp: 11,
  items: [item("sp", "race"), item("bg", "background"), item("cl", "class", { levels: 1 }), item("sub", "subclass"),
    item("feat", "feat", { source: U("granted"), origin: `${ID("cl")}.${ID("adv")}` })],
  ...over
});
const allowAll = { isAllowed: () => true };
const allowRoots = { isAllowed: u => !u.includes("granted") && !u.includes("smuggled") };

test("built structure: one of each root, level 1, HP, provenance", () => {
  assert.deepEqual(checkBuiltStructure(summary(), allowAll), []);
  assert.deepEqual(checkBuiltStructure(summary(), allowRoots), [], "a granted item needs no allowance of its own");
});

test("built structure: missing or doubled roots, two subclasses, wrong level, no HP", () => {
  const s = summary();
  assert.deepEqual(codes(checkBuiltStructure({ ...s, items: s.items.filter(i => i.type !== "race") }, allowAll)), ["SPECIES_MISSING"]);
  assert.deepEqual(codes(checkBuiltStructure({ ...s, items: [...s.items, item("bg2", "background")] }, allowAll)), ["BACKGROUND_NOT_ALLOWED"]);
  assert.deepEqual(codes(checkBuiltStructure({ ...s, items: [...s.items, item("sub2", "subclass")] }, allowAll)), ["CLASS_NOT_ALLOWED"]);
  assert.deepEqual(codes(checkBuiltStructure({ ...s, level: 2 }, allowAll)), ["CLASS_NOT_ALLOWED"]);
  const twoLevels = s.items.map(i => (i.type === "class" ? { ...i, levels: 2 } : i));
  assert.deepEqual(codes(checkBuiltStructure({ ...s, items: twoLevels }, allowAll)), ["CLASS_NOT_ALLOWED"]);
  assert.deepEqual(codes(checkBuiltStructure({ ...s, hp: 0 }, allowAll)), ["APPLY_FAILED"]);
});

test("built structure: an item neither allowed nor granted by an item on the character is rejected", () => {
  const s = summary();
  const smuggled = item("x", "weapon", { source: U("smuggled") });
  const fakeOrigin = item("y", "feat", { source: U("smuggled2"), origin: `${ID("gone")}.${ID("adv")}` });
  const selfOrigin = item("z", "feat", { source: U("smuggled3"), origin: `${ID("z")}.${ID("adv")}` });
  const notAllowed = { isAllowed: u => !u.includes("smuggled") };
  for ( const bad of [smuggled, fakeOrigin, selfOrigin] ) {
    const errs = checkBuiltStructure({ ...s, items: [...s.items, bad] }, notAllowed);
    assert.deepEqual(codes(errs), ["UNKNOWN_ITEM"], bad.name);
    assert.deepEqual(errs[0].detail.items.map(i => i.name), [bad.name]);
  }
  const noSource = item("w", "loot", { source: null });
  assert.deepEqual(codes(checkBuiltStructure({ ...s, items: [...s.items, noSource] }, allowAll)), ["UNKNOWN_ITEM"]);
});

test("details: a name is required", () => {
  assert.deepEqual(codes(checkDetails(draft())), ["NAME_REQUIRED"]);
  assert.deepEqual(codes(checkDetails(draft({ details: { ...draft().details, name: "   " } }))), ["NAME_REQUIRED"]);
  assert.deepEqual(checkDetails(draft({ details: { ...draft().details, name: "Tamsin" } })), []);
});

test("portrait: optional; when sent it must be a WebP within the limits", () => {
  assert.deepEqual(checkPortraitImage(null), []);
  assert.deepEqual(checkPortraitImage({ mime: "image/webp", data: "AAAA", width: 10, height: 10 }), []);
  assert.deepEqual(codes(checkPortraitImage({ mime: "image/png", data: "AAAA", width: 10, height: 10 })), ["BAD_IMAGE"]);
  assert.deepEqual(codes(checkPortraitImage({ mime: "image/webp", data: "AAAA", width: 5000, height: 10 })), ["BAD_IMAGE"]);
});

test("character limit (A4)", () => {
  assert.deepEqual(checkCharacterLimit(), []);
  assert.deepEqual(checkCharacterLimit({ limit: 1, existing: 0 }), []);
  assert.deepEqual(codes(checkCharacterLimit({ limit: 1, existing: 1 })), ["CHARACTER_LIMIT"]);
  assert.deepEqual(checkCharacterLimit({ limit: null, existing: 9 }), []);
});

test("errors are grouped by the wizard step to revisit, in step order", () => {
  const errs = [...checkDetails(draft()), ...checkCharacterLimit({ limit: 1, existing: 2 }),
    ...checkBuiltStructure({ ...summary(), level: 2 }, allowAll)];
  assert.deepEqual(errorsByStep(errs).map(g => [g.step, codes(g.errors)]),
    [["start", ["CHARACTER_LIMIT"]], ["class", ["CLASS_NOT_ALLOWED"]], ["details", ["NAME_REQUIRED"]]]);
  assert.deepEqual(errorsByStep([]), []);
});

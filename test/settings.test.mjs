import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SETTINGS, DEFAULTS, normalizeSettings, normalizeRestrictions } from "../scripts/settings/normalize.mjs";

const read = values => normalizeSettings(key => values[key]);

test("defaults (DESIGN.md → Settings)", () => {
  assert.deepEqual(read({}), {
    restrictions: { packs: null, categories: {} },
    abilityMethods: ["pointBuy", "standardArray", "rolled"],
    characterLimit: 1,
    folderName: "Player Characters",
    showOnLogin: true,
    portraits: { enabled: true, maxSourceBytes: 10 * 1024 * 1024 },
    ringColors: { ring: null, background: null },
    optionArt: {},
    stepArt: {},
    hardcore: { offered: true, free: [] }
  });
});

test("stored values are used when valid", () => {
  const s = read({ [SETTINGS.ABILITY_METHODS]: ["rolled", "pointBuy"], [SETTINGS.CHARACTER_LIMIT]: 3, [SETTINGS.FOLDER]: "  Heroes ",
    [SETTINGS.SHOW_ON_LOGIN]: false, [SETTINGS.UPLOADS]: false, [SETTINGS.MAX_UPLOAD_MB]: 4,
    [SETTINGS.RING_COLORS]: { ring: "#AABBCC", background: "#000000" } });
  assert.deepEqual(s.abilityMethods, ["pointBuy", "rolled"], "canonical order");
  assert.equal(s.characterLimit, 3);
  assert.equal(s.folderName, "Heroes");
  assert.equal(s.showOnLogin, false);
  assert.deepEqual(s.portraits, { enabled: false, maxSourceBytes: 4 * 1024 * 1024 });
  assert.deepEqual(s.ringColors, { ring: "#aabbcc", background: "#000000" });
  assert.equal(read({ [SETTINGS.CHARACTER_LIMIT]: 0 }).characterLimit, null, "0 = no limit");
  assert.equal(read({ [SETTINGS.FOLDER]: "" }).folderName, "", "empty = no folder");
});

test("corrupt values fall back to safe defaults", () => {
  const s = read({ [SETTINGS.ABILITY_METHODS]: ["manual"], [SETTINGS.CHARACTER_LIMIT]: -2, [SETTINGS.FOLDER]: 7,
    [SETTINGS.SHOW_ON_LOGIN]: "yes", [SETTINGS.MAX_UPLOAD_MB]: "lots", [SETTINGS.RING_COLORS]: { ring: "red" },
    [SETTINGS.RESTRICTIONS]: "everything" });
  assert.deepEqual(s.abilityMethods, ["pointBuy", "standardArray", "rolled"], "no method left: all allowed");
  assert.equal(s.characterLimit, 1);
  assert.equal(s.folderName, "Player Characters");
  assert.equal(s.showOnLogin, true);
  assert.equal(s.portraits.maxSourceBytes, 10 * 1024 * 1024);
  assert.deepEqual(s.ringColors, { ring: null, background: null });
  assert.deepEqual(s.restrictions, { packs: null, categories: {} });
  assert.equal(read({ [SETTINGS.MAX_UPLOAD_MB]: 500 }).portraits.maxSourceBytes, 50 * 1024 * 1024, "clamped");
  const throwing = normalizeSettings(() => {
    throw new Error("not registered");
  });
  assert.equal(throwing.characterLimit, DEFAULTS[SETTINGS.CHARACTER_LIMIT]);
});

test("restrictions keep known categories and string lists only", () => {
  assert.deepEqual(normalizeRestrictions({ packs: ["dnd5e.classes", "dnd5e.classes"], categories: {
    class: ["Compendium.a.b.Item.x"], species: [], spell: null, nonsense: ["x"], feat: [1, 2] } }),
  { packs: ["dnd5e.classes"], categories: { class: ["Compendium.a.b.Item.x"], species: [] } });
});

test("every setting has a label and hint in lang/en.json", async () => {
  const lang = JSON.parse(await readFile(new URL("../lang/en.json", import.meta.url), "utf8"));
  for ( const key of Object.values(SETTINGS) ) {
    assert.ok(lang.CHARCREATOR.Settings?.[key]?.Name, `${key} name`);
    assert.ok(lang.CHARCREATOR.Settings?.[key]?.Hint, `${key} hint`);
  }
});

test("a GM's own picture per option is a plain path or nothing (D24)", () => {
  const art = read({ [SETTINGS.OPTION_ART]: {
    "Compendium.dnd5e.races.Item.aaaaaaaaaaaaaaaa": "worlds/w/assets/elf.webp",
    "Compendium.dnd5e.races.aaaaaaaaaaaaaaab": "  worlds/w/assets/dwarf.webp  ",
    "Compendium.dnd5e.races.Item.aaaaaaaaaaaaaaac": "https://example.com/art.webp",
    "Compendium.dnd5e.races.Item.aaaaaaaaaaaaaaad": "data:image/png;base64,AAAA",
    "Compendium.dnd5e.races.Item.aaaaaaaaaaaaaaah": "file:///C:/art.webp",
    "Compendium.dnd5e.races.Item.aaaaaaaaaaaaaaae": "   ",
    "Compendium.dnd5e.races.Item.aaaaaaaaaaaaaaaf": 42,
    "Compendium.dnd5e.races.Item.aaaaaaaaaaaaaaag": "x".repeat(600)
  } }).optionArt;
  assert.deepEqual(art, {
    "Compendium.dnd5e.races.Item.aaaaaaaaaaaaaaaa": "worlds/w/assets/elf.webp",
    "Compendium.dnd5e.races.Item.aaaaaaaaaaaaaaab": "worlds/w/assets/dwarf.webp"
  }, "short UUIDs are normalised, paths trimmed, and anything that is not a path in this world dropped");
  assert.deepEqual(read({ [SETTINGS.OPTION_ART]: "nonsense" }).optionArt, {});
});

test("the GM's background per step keeps known steps and paths in this world only (D28)", () => {
  const art = read({ [SETTINGS.STEP_ART]: {
    species: " worlds/w/splash/mountains.webp ",
    spells: "https://example.com/stars.webp",
    review: "data:image/png;base64,AAAA",
    nonsense: "worlds/w/x.webp",
    class: 7
  } }).stepArt;
  assert.deepEqual(art, { species: "worlds/w/splash/mountains.webp" });
  assert.deepEqual(read({ [SETTINGS.STEP_ART]: [1, 2] }).stepArt, {});
});

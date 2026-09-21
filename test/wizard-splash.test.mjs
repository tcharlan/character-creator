import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { splashFor, sigilPath } from "../scripts/wizard/splash.mjs";
import { STEPS } from "../scripts/contracts.mjs";

/* The backdrop behind each step (D28): the GM's picture, else the step's own sigil over the picked option's art. */

const ELF = "Compendium.dnd5e.races.Item.aaaaaaaaaaaaaaaa";
const WIZARD = "Compendium.dnd5e.classes.Item.bbbbbbbbbbbbbbbb";
const catalog = { get: uuid => ({ [ELF]: { img: "systems/dnd5e/icons/elf.webp" },
  [WIZARD]: { img: "icons/svg/item-bag.svg" } })[uuid] };

test("every step has a sigil, and it ships with the module", async () => {
  for ( const step of STEPS ) {
    const path = sigilPath(step);
    assert.equal(path, `modules/character-creator/assets/splash/${step}.svg`);
    await access(new URL(`../assets/splash/${step}.svg`, import.meta.url));
  }
  assert.equal(sigilPath("nonsense"), sigilPath("start"));
});

test("with nothing picked, a step shows its sigil alone", () => {
  assert.deepEqual(splashFor("species"), { step: "species", sigil: sigilPath("species"), image: null, source: null });
});

test("the picked option's picture sits behind its own step", () => {
  const splash = splashFor("species", { picks: { species: ELF }, catalog });
  assert.equal(splash.image, "systems/dnd5e/icons/elf.webp");
  assert.equal(splash.source, "pick");
  assert.equal(splash.sigil, sigilPath("species"), "the sigil stays over it");
});

test("the GM's picture per option wins over the compendium's", () => {
  const splash = splashFor("species", { picks: { species: ELF }, catalog, optionArt: { [ELF]: "worlds/w/elf.webp" } });
  assert.equal(splash.image, "worlds/w/elf.webp");
});

test("later steps show the class, and Foundry's placeholder icons are never a backdrop", () => {
  assert.equal(splashFor("spells", { picks: { class: WIZARD }, catalog }).image, null, "item-bag placeholder");
  const withArt = splashFor("spells", { picks: { class: WIZARD }, catalog, optionArt: { [WIZARD]: "worlds/w/wizard.webp" } });
  assert.equal(withArt.image, "worlds/w/wizard.webp");
  assert.equal(splashFor("start", { picks: { class: WIZARD }, catalog, optionArt: { [WIZARD]: "x.webp" } }).image, null,
    "the start screen has nothing picked to show");
});

test("the GM's picture for a step replaces both the sigil and the pick", () => {
  assert.deepEqual(splashFor("species", { picks: { species: ELF }, catalog, stepArt: { species: "worlds/w/m.webp" } }),
    { step: "species", sigil: null, image: "worlds/w/m.webp", source: "gm" });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const readJSON = async path => JSON.parse(await readFile(new URL(path, root), "utf8"));

test("module.json declares the id, Foundry v14 and dnd5e >= 5.3.0", async () => {
  const manifest = await readJSON("module.json");
  assert.equal(manifest.id, "character-creator");
  assert.equal(manifest.compatibility.minimum, "14");
  const dnd5e = manifest.relationships.systems.find(s => s.id === "dnd5e");
  assert.ok(dnd5e, "dnd5e relationship missing");
  assert.equal(dnd5e.compatibility.minimum, "5.3.0");
});

test("module.json has no manifest or download URLs before release (PLAN 0.2)", async () => {
  const manifest = await readJSON("module.json");
  assert.equal(manifest.manifest, undefined);
  assert.equal(manifest.download, undefined);
});

test("every file module.json references exists", async () => {
  const manifest = await readJSON("module.json");
  const paths = [...manifest.esmodules, ...manifest.styles, ...manifest.languages.map(l => l.path)];
  for ( const path of paths ) await access(new URL(path, root));
});

test("lang/en.json is valid JSON with the module title", async () => {
  const en = await readJSON("lang/en.json");
  assert.equal(en.CHARCREATOR.Title, "Character Creator");
});

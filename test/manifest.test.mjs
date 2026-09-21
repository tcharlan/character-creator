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

test("the release URLs point at GitHub releases, and the download at this version (PLAN 6.2)", async () => {
  const manifest = await readJSON("module.json");
  const repo = manifest.url;
  assert.match(repo, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
  assert.equal(manifest.manifest, `${repo}/releases/latest/download/module.json`);
  assert.equal(manifest.download, `${repo}/releases/download/v${manifest.version}/module.zip`);
  assert.equal(manifest.bugs, `${repo}/issues`);
});

test("module.json and package.json carry the same version", async () => {
  const [manifest, pkg] = await Promise.all([readJSON("module.json"), readJSON("package.json")]);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
});

test("the compatibility this release was checked against is declared (PLAN 6.3)", async () => {
  const manifest = await readJSON("module.json");
  assert.ok(manifest.compatibility.verified, "Foundry verified version");
  const dnd5e = manifest.relationships.systems.find(s => s.id === "dnd5e");
  assert.ok(dnd5e.compatibility.verified, "dnd5e verified version");
  assert.ok(manifest.authors?.length, "authors");
  await access(new URL(manifest.license, root));
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

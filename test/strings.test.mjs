import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

/*
 * Every word a player or GM reads comes from lang/en.json (A3, PLAN 5.3). These tests read the templates and
 * the scripts and check that nothing is written in place, and that every key asked for is really there.
 */

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

/** Every file under a directory, recursively, with one of these extensions. */
async function files(dir, ext) {
  const out = [];
  for ( const entry of await readdir(new URL(dir, root), { withFileTypes: true }) ) {
    const path = `${dir}${entry.name}`;
    if ( entry.isDirectory() ) out.push(...await files(`${path}/`, ext));
    else if ( entry.name.endsWith(ext) ) out.push(path);
  }
  return out;
}

const lang = JSON.parse(await read("lang/en.json"));
const at = key => key.split(".").reduce((o, k) => o?.[k], lang);
const templates = await files("templates/", ".hbs");
const scripts = await files("scripts/", ".mjs");

test("every key the templates ask for is in lang/en.json", async () => {
  const missing = [];
  for ( const path of templates ) {
    const source = await read(path);
    // {{localize "KEY"}}, {{localize 'KEY'}}, and (localize "KEY") inside another helper.
    for ( const [, key] of source.matchAll(/localize\s+["']([\w.]+)["']/g) ) {
      if ( typeof at(key) !== "string" ) missing.push(`${path}: ${key}`);
    }
    // {{localize (concat "PREFIX." something)}}: the prefix has to lead somewhere.
    for ( const [, prefix] of source.matchAll(/concat\s+["']([\w.]+)\.["']?/g) ) {
      if ( at(prefix.replace(/\.$/, "")) === undefined ) missing.push(`${path}: ${prefix}…`);
    }
  }
  assert.deepEqual(missing, []);
});

test("every key the scripts ask for is in lang/en.json", async () => {
  const missing = [];
  for ( const path of scripts ) {
    const source = await read(path);
    // Only our own keys: Foundry's and dnd5e's come from their language files.
    for ( const [, key] of source.matchAll(/i18n\.(?:localize|format)\(\s*["'](CHARCREATOR[\w.]*)["']/g) ) {
      if ( typeof at(key) !== "string" ) missing.push(`${path}: ${key}`);
    }
    // The module's own helper, where a file defines one: T("Section.Key") is CHARCREATOR.Section.Key.
    if ( /const T = .*CHARCREATOR\./.test(source) ) {
      for ( const [, key] of source.matchAll(/[^.\w]T\(\s*["']([\w.]+)["']/g) ) {
        if ( typeof at(`CHARCREATOR.${key}`) !== "string" ) missing.push(`${path}: CHARCREATOR.${key}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("the templates hold no words of their own", async () => {
  const problems = [];
  for ( const path of templates ) {
    let source = await read(path);
    source = source
      .replace(/\{\{![\s\S]*?\}\}/g, " ")          // comments
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/\{\{[\s\S]*?\}\}/g, "{}")          // anything the code fills in
      .replace(/<[^>]*>/g, "\n")                   // tags, with their attributes
      .replace(/&[a-z]+;/g, " ");                 // &minus; and friends are symbols, not words
    for ( const line of source.split("\n") ) {
      const text = line.replace(/\{\}/g, " ").trim();
      // What's left between tags should be punctuation or symbols, never a word.
      if ( /[A-Za-z]{2,}/.test(text) ) problems.push(`${path}: ${text.slice(0, 60)}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("nothing is told to a player in words written in the code", async () => {
  const problems = [];
  for ( const path of scripts ) {
    const source = await read(path);
    // A notification with a literal rather than a key, e.g. ui.notifications.warn("Careful!").
    for ( const [line] of source.matchAll(/notifications\??\.\w+\(\s*["'][^"']*[A-Za-z]{3,}[^"']*["']/g) ) {
      problems.push(`${path}: ${line.slice(0, 60)}`);
    }
  }
  assert.deepEqual(problems, []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { entryState, loginPrompt, ENTRY_KINDS } from "../scripts/ui/entry.mjs";

test("the button offers what the draft's state allows", () => {
  assert.deepEqual([entryState({ state: "none" }).kind, entryState({ state: "editable" }).kind,
    entryState({ state: "submitted" }).kind, entryState({ state: "created" }).kind],
  ["create", "continue", "waiting", "ready"]);
  // A draft that can't be resumed here is offered as a fresh start (the wizard asks to discard it).
  for ( const state of ["otherWorld", "otherRules", "tooNew", "broken"] ) {
    assert.equal(entryState({ state }).kind, "create", state);
  }
  const create = entryState({ state: "none" });
  assert.deepEqual([create.visible, create.hidden], [true, null]);
  assert.equal(create.label, "CHARCREATOR.Entry.create.Button");
  assert.equal(entryState({ state: "editable" }).tooltip, "CHARCREATOR.Entry.continue.Tooltip");
});

test("it's hidden for a GM, and at the character limit", () => {
  assert.deepEqual(entryState({ state: "none", isGM: true }).hidden, "gm");
  assert.equal(entryState({ state: "editable", isGM: true }).visible, false, "the GM's own drafts too");
  assert.equal(entryState({ state: "none", limit: 1, created: 1 }).hidden, "limit");
  assert.equal(entryState({ state: "none", limit: 2, created: 1 }).visible, true);
  assert.equal(entryState({ state: "none", limit: null, created: 9 }).visible, true, "no limit set");
  // A draft already under way stays reachable, so it can be finished or discarded.
  assert.equal(entryState({ state: "editable", limit: 1, created: 1 }).visible, true);
  assert.equal(entryState({ state: "created", limit: 1, created: 1 }).visible, true);
});

test("the prompt nudges a player without a character, and always reports a result", () => {
  const prompt = (state, options) => loginPrompt(entryState({ state }), options);
  assert.equal(prompt("none", {}).message, "CHARCREATOR.Entry.create.Prompt");
  assert.equal(prompt("none", { showOnLogin: false }), null, "the GM turned it off");
  assert.equal(prompt("none", { hasCharacter: true }), null, "they already play someone");
  assert.equal(prompt("editable", {}).kind, "continue");
  // Results answer something the player sent, so neither the setting nor an existing character hides them.
  assert.equal(prompt("created", { showOnLogin: false, hasCharacter: true }).kind, "ready");
  assert.equal(prompt("submitted", { showOnLogin: false, hasCharacter: true }).kind, "waiting");
  assert.deepEqual([prompt("created", {}).permanent, prompt("submitted", {}).permanent], [true, false]);
  assert.equal(loginPrompt(entryState({ state: "none", isGM: true }), {}), null, "nothing to prompt a GM about");
});

test("every label the entry points use is in lang/en.json", async () => {
  const { readFile } = await import("node:fs/promises");
  const lang = JSON.parse(await readFile(new URL("../lang/en.json", import.meta.url), "utf8"));
  const at = key => key.split(".").reduce((o, k) => o?.[k], lang);
  for ( const kind of ENTRY_KINDS ) {
    const entry = entryState({ state: { create: "none", continue: "editable", waiting: "submitted", ready: "created" }[kind] });
    assert.equal(entry.kind, kind);
    for ( const key of [entry.label, entry.tooltip, `CHARCREATOR.Entry.${kind}.Prompt`] ) {
      assert.equal(typeof at(key), "string", key);
    }
  }
  assert.equal(typeof at("CHARCREATOR.Notify.CreatedGone"), "string");
});

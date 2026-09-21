import { test } from "node:test";
import assert from "node:assert/strict";
import { entryState, loginPrompt, allowance, ENTRY_KINDS } from "../scripts/ui/entry.mjs";

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

test("a GM sees what is waiting to be created, and nothing when the queue is empty", () => {
  assert.equal(entryState({ state: "none", isGM: true, waiting: 0 }).hidden, "gm");
  const queue = entryState({ state: "none", isGM: true, waiting: 3 });
  assert.deepEqual([queue.visible, queue.kind, queue.count], [true, "queue", 3]);
  assert.equal(queue.label, "CHARCREATOR.Entry.queue.Button");
  assert.equal(entryState({ state: "editable", isGM: true, waiting: 2 }).kind, "queue",
    "a GM's own half-written draft is still not offered here");
});

test("how many characters a player may still make (A4)", () => {
  assert.deepEqual(allowance({ limit: 1, made: 0 }), { limit: 1, made: 0, left: 1, atLimit: false, unlimited: false });
  assert.deepEqual(allowance({ limit: 3, made: 1 }).left, 2);
  assert.equal(allowance({ limit: 1, made: 1 }).atLimit, true);
  assert.equal(allowance({ limit: 1, made: 4 }).left, 0, "over the limit is still none left, not a negative");
  const none = allowance({ limit: null, made: 9 });
  assert.deepEqual([none.unlimited, none.atLimit, none.left], [true, false, null]);
  assert.equal(allowance().unlimited, true);
});

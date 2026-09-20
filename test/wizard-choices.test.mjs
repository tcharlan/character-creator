import { test } from "node:test";
import assert from "node:assert/strict";
import { choicesModel, answerData, CHOICE_TYPES } from "../scripts/wizard/choices-step.mjs";

const ID = n => String(n).padEnd(16, "0");
const U = n => `Compendium.test.x.Item.${ID(n)}`;
/** A stand-in catalog: names from the UUID. */
const catalog = { get: uuid => ({ name: `Item ${uuid.slice(-3, -1)}`, img: "icon.webp" }) };

const result = (over = {}) => ({
  key: "k1", path: ["class"], advancementId: ID("a"), level: 1, item: "Cleric", title: "Skills", type: "Trait",
  status: "needsInput", data: null, errors: [], ...over
});

test("choices are grouped by the item that offers them, with counts", () => {
  const built = { results: [
    result({ key: "a", item: "High Elf", title: "Languages", status: "done", data: { chosen: ["languages:elvish"] },
      options: { type: "Trait", allowed: ["languages:elvish"], grants: [], max: 1 } }),
    result({ key: "b", item: "Cleric", title: "Skills", status: "needsInput",
      options: { type: "Trait", allowed: ["skills:his", "skills:ins"], grants: [], max: 2 } }),
    result({ key: "c", item: "Cleric", title: "Hit Points", type: "HitPoints", status: "auto", options: { type: "HitPoints" } }),
    result({ key: "d", item: "Cleric", title: "Divine Domain", type: "Subclass", status: "needsInput",
      options: { type: "Subclass", options: [U("life")] } })
  ] };
  const model = choicesModel(built, catalog);
  assert.deepEqual(model.groups.map(g => g.item), ["High Elf", "Cleric"], "in build order, one group per item");
  assert.deepEqual(model.groups[1].choices.map(c => c.title), ["Skills", "Divine Domain"], "read-only steps aren't listed");
  assert.deepEqual(model.counts, { total: 3, open: 2, invalid: 0, done: 1 });
  assert.equal(model.open.title, "Skills", "the first unanswered choice opens");
  assert.equal(model.groups[1].choices[0].open, true);
  const chosen = choicesModel(built, catalog, "d");
  assert.equal(chosen.open.title, "Divine Domain", "or the one the player opened");
});

test("a broken answer is shown as invalid, with its message", () => {
  const built = { results: [result({ status: "invalid", errors: [{ key: "CHARCREATOR.Error.TOO_MANY_PICKS" }],
    data: { chosen: ["skills:ath", "skills:acr"] }, options: { type: "Trait", allowed: ["skills:ath"], grants: [], max: 1 } })] };
  const model = choicesModel(built, catalog);
  assert.equal(model.counts.invalid, 1);
  assert.deepEqual(model.open.errors, ["CHARCREATOR.Error.TOO_MANY_PICKS"]);
});

test("trait widget: granted keys are fixed, and picks stop at the count", () => {
  const options = { type: "Trait", allowed: ["skills:his", "skills:ins", "skills:med"], grants: ["skills:his"], max: 2,
    replacements: false };
  const r = result({ options, data: { chosen: ["skills:his"] } });
  const widget = choicesModel({ results: [r] }, catalog).open.widget;
  assert.equal(widget.type, "Trait");
  assert.deepEqual(widget.list.map(o => [o.key, o.checked, o.disabled]),
    [["skills:his", true, true], ["skills:ins", false, false], ["skills:med", false, false]]);
  assert.deepEqual([widget.chosen, widget.needed], [1, 2]);
  assert.deepEqual(answerData(r, { value: "skills:ins" }), { chosen: ["skills:his", "skills:ins"] });
  const full = result({ options, data: { chosen: ["skills:his", "skills:ins"] } });
  assert.equal(answerData(full, { value: "skills:med" }), null, "no room for a third");
  assert.deepEqual(answerData(full, { value: "skills:ins" }), { chosen: ["skills:his"] }, "clicking again clears it");
  assert.equal(answerData(full, { value: "skills:his" }), null, "a granted key can't be dropped");
  assert.equal(answerData(full, { value: "skills:ste" }), null, "not on the list");
});

test("trait widget: with replacements a granted key may be swapped (2014 Acolyte)", () => {
  const options = { type: "Trait", allowed: ["skills:ins", "skills:rel", "skills:his"], grants: ["skills:ins"], max: 2,
    replacements: true };
  const r = result({ options, data: { chosen: ["skills:ins", "skills:rel"] } });
  assert.deepEqual(answerData(r, { value: "skills:ins" }), { chosen: ["skills:rel"] });
});

test("item choice: pick up to the count, and choose a spellcasting ability when asked", () => {
  const options = { type: "ItemChoice", count: 2, itemType: "feat", options: [U("aa"), U("bb"), U("cc")], abilityOptions: [] };
  const r = result({ type: "ItemChoice", options, data: { selected: [U("aa")] } });
  const widget = choicesModel({ results: [r] }, catalog).open.widget;
  assert.deepEqual([widget.needed, widget.chosen], [2, 1]);
  assert.equal(widget.list.filter(o => o.selected).length, 1);
  assert.equal(widget.ability, null, "no ability to choose");
  assert.deepEqual(answerData(r, { value: U("bb") }), { selected: [U("aa"), U("bb")] });
  const full = result({ type: "ItemChoice", options, data: { selected: [U("aa"), U("bb")] } });
  assert.equal(answerData(full, { value: U("cc") }), null);
  assert.deepEqual(answerData(full, { value: U("aa") }), { selected: [U("bb")] });

  const withAbility = result({ type: "ItemChoice", data: { selected: [U("aa")] },
    options: { ...options, abilityOptions: ["int", "wis", "cha"] } });
  const w2 = choicesModel({ results: [withAbility] }, catalog).open.widget;
  assert.deepEqual(w2.ability.list.map(a => a.key), ["int", "wis", "cha"]);
  assert.deepEqual(answerData(withAbility, { action: "ability", value: "wis" }), { selected: [U("aa")], ability: "wis" });
});

test("item grant: required items stay, optional ones can be turned down", () => {
  const options = { type: "ItemGrant", abilityOptions: [],
    items: [{ uuid: U("aa"), optional: false }, { uuid: U("bb"), optional: true }] };
  const r = result({ type: "ItemGrant", options, data: { selected: [U("aa"), U("bb")] } });
  const widget = choicesModel({ results: [r] }, catalog).open.widget;
  assert.deepEqual(widget.list.map(i => [i.optional, i.selected]), [[false, true], [true, true]]);
  assert.equal(answerData(r, { value: U("aa") }), null, "a required item can't be turned down");
  assert.deepEqual(answerData(r, { value: U("bb") }), { selected: [U("aa")] });
  const without = result({ type: "ItemGrant", options, data: { selected: [U("aa")] } });
  assert.deepEqual(answerData(without, { value: U("bb") }), { selected: [U("aa"), U("bb")] });
});

test("ability increases: fixed ones are kept, free points respect the cap and the budget", () => {
  const options = { type: "AbilityScoreImprovement", fixed: { con: 1 }, points: 2, cap: 1, locked: ["str"],
    improvable: ["str", "dex", "con", "int", "wis", "cha"] };
  const r = result({ type: "AbilityScoreImprovement", options, data: null });
  const widget = choicesModel({ results: [r] }, catalog).open.widget;
  assert.deepEqual([widget.points, widget.left], [2, 2], "2 free points, none spent yet");
  const con = widget.rows.find(x => x.key === "con");
  assert.deepEqual([con.fixed, con.value, con.canRaise], [1, 1, true]);
  assert.equal(widget.rows.find(x => x.key === "str").canRaise, false, "locked");
  const raised = answerData(r, { action: "raise", value: "dex" });
  assert.deepEqual(raised, { type: "asi", assignments: { con: 1, dex: 1 } });
  const twice = result({ type: "AbilityScoreImprovement", options, data: raised });
  assert.equal(answerData(twice, { action: "raise", value: "dex" }), null, "the cap is 1 per ability");
  const spent = result({ type: "AbilityScoreImprovement", options, data: { type: "asi", assignments: { con: 2, dex: 1, int: 1 } } });
  assert.equal(answerData(spent, { action: "raise", value: "wis" }), null, "no points left");
  assert.deepEqual(answerData(twice, { action: "lower", value: "dex" }), { type: "asi", assignments: { con: 1, dex: 0 } });
  assert.equal(answerData(twice, { action: "lower", value: "con" }), null, "a fixed increase can't be lowered");
});

test("size and subclass pick one option", () => {
  const size = result({ type: "Size", options: { type: "Size", sizes: ["sm", "med"] }, data: { size: "med" } });
  const widget = choicesModel({ results: [size] }, catalog).open.widget;
  assert.deepEqual(widget.list.map(s => [s.key, s.selected]), [["sm", false], ["med", true]]);
  assert.deepEqual(answerData(size, { value: "sm" }), { size: "sm" });
  assert.equal(answerData(size, { value: "huge" }), null);
  const sub = result({ type: "Subclass", options: { type: "Subclass", options: [U("life"), U("war")] }, data: null });
  assert.deepEqual(answerData(sub, { value: U("war") }), { uuid: U("war") });
  assert.equal(answerData(sub, { value: U("nope") }), null);
});

test("every type the widgets cover has an answer path", () => {
  for ( const type of CHOICE_TYPES ) {
    const r = result({ type, options: { type, allowed: [], grants: [], max: 0, items: [], options: [], sizes: [],
      fixed: {}, points: 0, cap: null, locked: [], improvable: [], count: 0, abilityOptions: [] } });
    assert.doesNotThrow(() => answerData(r, { value: "x" }), type);
    assert.doesNotThrow(() => choicesModel({ results: [r] }, catalog), type);
  }
});

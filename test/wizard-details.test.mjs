import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraft, checkDraftShape, LIMITS } from "../scripts/contracts.mjs";
import { checkDetails } from "../scripts/rules/draft-checks.mjs";
import { detailsModel, setDetail, fieldsFor, maxLength, PERSONALITY, setHeightPart, setAmount, parseHeight, parseAmount } from "../scripts/wizard/details-step.mjs";

const ID = n => String(n).padEnd(16, "0");
const draft = (rules = "legacy") => createDraft({ id: ID("d"), worldId: "w", rules, now: 1 });

test("both rule sets ask for the personality fields", () => {
  // The 2024 rules dropped the tables from backgrounds, but a character still has a trait, ideal, bond and flaw.
  const fields = fieldsFor();
  assert.deepEqual(Object.keys(PERSONALITY), ["traits", "ideals", "bonds", "flaws"]);
  for ( const key of Object.keys(PERSONALITY) ) assert.ok(fields.includes(key), key);
  assert.ok(fields.includes("name") && fields.includes("appearance"));
  for ( const rules of ["legacy", "modern"] ) {
    const model = detailsModel(draft(rules), { rules });
    assert.equal(model.personality, true, rules);
    assert.ok(model.fields.some(f => f.key === "flaws"), rules);
  }
});

test("only the name is required", () => {
  const d = draft();
  assert.deepEqual(checkDetails(d).map(e => e.code), ["NAME_REQUIRED"]);
  setDetail(d, "name", "Ilyra");
  assert.deepEqual(checkDetails(d), []);
  const model = detailsModel(d, { rules: "legacy" });
  assert.equal(model.hasName, true);
  assert.equal(model.fields.find(f => f.key === "name").required, true);
  assert.equal(model.fields.find(f => f.key === "eyes").required, false);
});

test("text is trimmed to what the draft allows, so a long paste can't break it", () => {
  const d = draft();
  setDetail(d, "name", "x".repeat(500));
  assert.equal(d.details.name.length, LIMITS.nameMaxLength);
  setDetail(d, "biography", "y".repeat(LIMITS.longTextMaxLength + 100));
  assert.equal(d.details.biography.length, LIMITS.longTextMaxLength);
  setDetail(d, "eyes", "z".repeat(LIMITS.shortTextMaxLength + 50));
  assert.equal(d.details.eyes.length, LIMITS.shortTextMaxLength);
  assert.deepEqual(checkDraftShape(d), []);
  assert.equal(maxLength("biography"), LIMITS.longTextMaxLength);
  assert.equal(maxLength("pronouns"), LIMITS.shortTextMaxLength);
});

test("an unknown field is ignored, and values become strings", () => {
  const d = draft();
  setDetail(d, "nonsense", "x");
  assert.ok(!("nonsense" in d.details));
  setDetail(d, "age", 27);
  assert.equal(d.details.age, "27");
  setDetail(d, "hair", null);
  assert.equal(d.details.hair, "");
  assert.deepEqual(checkDraftShape(d), []);
});

test("the model marks which fields are long, and which can be rolled", () => {
  const d = draft();
  setDetail(d, "traits", "Curious");
  const model = detailsModel(d, { rules: "legacy", tables: { traits: "Compendium.dnd5e.tables.RollTable.x" } });
  const traits = model.fields.find(f => f.key === "traits");
  assert.deepEqual([traits.long, traits.value, !!traits.table], [true, "Curious", true]);
  assert.equal(model.fields.find(f => f.key === "ideals").table, null, "no table, no roll button");
  assert.equal(model.fields.find(f => f.key === "pronouns").long, false);
  const modern = detailsModel(d, { rules: "modern", tables: { flaws: "Compendium.dnd5e.tables.RollTable.y" } });
  assert.ok(modern.fields.find(f => f.key === "flaws").table, "a 2024 world with a table can roll it too");
});

test("the numeric details are checked, but only just: no negatives, and an age is a number", () => {
  const model = over => detailsModel({ details: { name: "Brenna", ...over } }, { rules: "modern" });
  const problem = (over, field) => model(over).fields.find(f => f.key === field).problem;
  assert.equal(problem({ age: "1,000" }, "age"), null, "a very old elf is fine");
  assert.equal(problem({ age: "300 years" }, "age"), null);
  assert.equal(problem({ age: "" }, "age"), null, "an empty field is fine");
  assert.equal(problem({ age: "-4" }, "age"), "CHARCREATOR.Details.Problem.negative");
  assert.equal(problem({ age: "ancient" }, "age"), "CHARCREATOR.Details.Problem.notANumber");
  assert.equal(problem({ height: "tall" }, "height"), null, "height and weight take any words");
  assert.equal(problem({ weight: "-20 lb" }, "weight"), "CHARCREATOR.Details.Problem.negative");
  assert.equal(problem({ eyes: "-blue" }, "eyes"), null, "only the numeric fields are checked");
});

test("each field is asked for in the way it's answered", () => {
  const model = detailsModel({ details: { name: "Brenna", alignment: "Lawful Good", age: "34",
    height: "5 ft 7 in", weight: "150 lb" } }, { rules: "modern" });
  const field = key => model.fields.find(f => f.key === key);
  assert.equal(field("alignment").kind, "choice");
  assert.ok(field("alignment").options.some(o => (o.value === "Lawful Good") && o.selected));
  assert.equal(field("age").kind, "number");
  assert.equal(field("height").kind, "height");
  assert.deepEqual(field("height").parts.map(p => [p.part, p.value, p.unit]),
    [["feet", "5", "ft"], ["inches", "7", "in"]]);
  assert.deepEqual([field("weight").kind, field("weight").amount, field("weight").unit], ["amount", "150", "lb"]);
  assert.equal(field("name").kind, "text");
  assert.equal(field("appearance").kind, "long");
});

test("height and weight are stored the way a character sheet reads them", () => {
  const d = () => ({ details: { height: "", weight: "" } });
  assert.equal(setHeightPart(d(), "feet", "5").details.height, "5 ft");
  const both = setHeightPart(setHeightPart(d(), "feet", "5"), "inches", "7");
  assert.equal(both.details.height, "5 ft 7 in");
  assert.equal(setHeightPart(both, "inches", "").details.height, "5 ft", "clearing one keeps the other");
  assert.deepEqual(parseHeight("5 ft 7 in"), { feet: "5", inches: "7" });
  assert.deepEqual(parseHeight("6"), { feet: "6", inches: "" }, "a bare number is feet");
  assert.deepEqual(parseHeight(""), { feet: "", inches: "" });
  assert.equal(setAmount(d(), "weight", "150", "lb").details.weight, "150 lb");
  assert.equal(setAmount(d(), "weight", "", "lb").details.weight, "", "an empty field stays empty");
  assert.equal(parseAmount("150 lb"), "150");
});

test("colours are words, not numbers", () => {
  const model = over => detailsModel({ details: { name: "Brenna", ...over } }, { rules: "modern" });
  const problem = (over, field) => model(over).fields.find(f => f.key === field).problem;
  assert.equal(problem({ eyes: "green" }, "eyes"), null);
  assert.equal(problem({ hair: "salt-and-pepper" }, "hair"), null);
  assert.equal(problem({ skin: "#00ff00" }, "skin"), "CHARCREATOR.Details.Problem.notWords");
  assert.equal(problem({ eyes: "" }, "eyes"), null);
});

test("on a rolled character only the details the dice settled are closed (D31)", async () => {
  const { ROLLED_DETAILS } = await import("../scripts/rules/random.mjs");
  const d = draft();
  d.details.alignment = "Chaotic Evil";
  const model = detailsModel(d, { rules: "legacy", locked: ROLLED_DETAILS });
  const locked = model.fields.filter(f => f.locked).map(f => f.key).sort();
  assert.deepEqual(locked, ["alignment", "bonds", "flaws", "ideals", "traits"]);
  assert.equal(model.anyLocked, true);
  for ( const key of ["name", "age", "height", "weight", "eyes", "hair", "skin", "appearance", "biography"] ) {
    assert.equal(model.fields.find(f => f.key === key)?.locked, false, `${key} stays the player's`);
  }
  assert.equal(detailsModel(d, { rules: "legacy" }).anyLocked, false, "nothing is closed in an ordinary character");
});

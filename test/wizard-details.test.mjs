import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraft, checkDraftShape, LIMITS } from "../scripts/contracts.mjs";
import { checkDetails } from "../scripts/rules/draft-checks.mjs";
import { detailsModel, setDetail, fieldsFor, maxLength, PERSONALITY } from "../scripts/wizard/details-step.mjs";

const ID = n => String(n).padEnd(16, "0");
const draft = (rules = "legacy") => createDraft({ id: ID("d"), worldId: "w", rules, now: 1 });

test("2014 characters get the personality fields; 2024 ones don't", () => {
  const legacy = fieldsFor("legacy");
  const modern = fieldsFor("modern");
  assert.deepEqual(Object.keys(PERSONALITY), ["traits", "ideals", "bonds", "flaws"]);
  for ( const key of Object.keys(PERSONALITY) ) {
    assert.ok(legacy.includes(key), key);
    assert.ok(!modern.includes(key), key);
  }
  assert.ok(modern.includes("name") && modern.includes("appearance"));
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
  assert.equal(detailsModel(d, { rules: "modern" }).personality, false);
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

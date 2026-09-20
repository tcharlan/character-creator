import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraft, makeError } from "../scripts/contracts.mjs";
import { BANNER_STEPS, NUMERALS, stepState, bannerSteps, canOpen, moveStep, groupErrors, attention }
  from "../scripts/wizard/steps-model.mjs";

const ID = n => String(n).padEnd(16, "0");
const U = n => `Compendium.test.x.Item.${ID(n)}`;
const draft = picks => ({ ...createDraft({ id: ID("d"), worldId: "w", rules: "legacy", now: 1 }),
  picks: { species: null, background: null, class: null, ...picks } });
const full = draft({ species: U("sp"), background: U("bg"), class: U("cl") });

test("the banner holds the ten wizard steps, in order, with numerals", () => {
  assert.deepEqual(BANNER_STEPS, ["species", "class", "background", "abilities", "choices", "equipment", "spells",
    "details", "portrait", "review"]);
  assert.equal(NUMERALS.length, BANNER_STEPS.length);
  assert.equal(NUMERALS.at(-1), "X");
});

test("steps that build on picks are locked until those picks exist", () => {
  assert.ok(canOpen("species", draft()));
  assert.ok(canOpen("abilities", draft()));
  assert.ok(!canOpen("choices", draft({ species: U("sp") })));
  assert.ok(!canOpen("equipment", draft({ class: U("cl") })));
  assert.ok(canOpen("spells", draft({ class: U("cl") })));
  assert.ok(canOpen("choices", full));
  assert.ok(!canOpen("start", full), "start isn't a banner step");
});

test("each step's state: current, locked, attention, done, todo", () => {
  const errorsByStep = { spells: [makeError("CANTRIP_COUNT")] };
  const opts = { current: "class", draft: full, errorsByStep, visited: ["species"] };
  assert.equal(stepState("class", opts), "current");
  assert.equal(stepState("species", opts), "done");
  assert.equal(stepState("spells", opts), "attention");
  assert.equal(stepState("equipment", opts), "todo");
  assert.equal(stepState("choices", { ...opts, draft: draft({ class: U("cl") }) }), "locked");
  assert.equal(stepState("choices", { ...opts, current: "choices", draft: draft() }), "current", "the step you're on is never locked");
});

test("the banner model carries labels and error counts", () => {
  const rows = bannerSteps({ current: "class", draft: full, labels: { species: "High Elf" },
    errorsByStep: { spells: [makeError("CANTRIP_COUNT"), makeError("SPELL_COUNT")] }, visited: ["species"] });
  assert.equal(rows.length, 10);
  assert.deepEqual(rows[0], { key: "species", numeral: "I", state: "done", locked: false, label: "High Elf", count: 0 });
  assert.equal(rows.find(r => r.key === "spells").count, 2);
  assert.equal(rows.find(r => r.key === "class").state, "current");
});

test("Back and Next skip steps whose picks are missing", () => {
  assert.equal(moveStep("species", 1, full), "class");
  assert.equal(moveStep("review", 1, full), null);
  assert.equal(moveStep("species", -1, full), null);
  const onlyClass = draft({ class: U("cl") });
  assert.equal(moveStep("abilities", 1, onlyClass), "spells", "choices and equipment need the other picks");
  assert.equal(moveStep("spells", -1, onlyClass), "abilities");
  assert.equal(moveStep("nowhere", 1, full), "species");
});

test("validator errors group by the step to revisit, and the footer counts them", () => {
  const errors = [makeError("CANTRIP_COUNT"), makeError("MISSING_STEP"), makeError("NAME_REQUIRED"), makeError("SPELL_COUNT")];
  const grouped = groupErrors(errors);
  assert.deepEqual(Object.keys(grouped).sort(), ["choices", "details", "spells"]);
  assert.equal(grouped.spells.length, 2);
  assert.deepEqual(attention(grouped), { steps: ["spells", "choices", "details"], errors: 4, ready: false });
  assert.deepEqual(attention({}), { steps: [], errors: 0, ready: true });
  assert.deepEqual(attention(groupErrors([])), { steps: [], errors: 0, ready: true });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { traitReference, firstSentence, spellMeta } from "../scripts/wizard/descriptions.mjs";

/** Enough of CONFIG.DND5E to walk a trait key, in the shape dnd5e uses. */
const CONFIG = {
  DND5E: {
    traits: { skills: { configKey: "skills" }, tool: { configKey: "tools" }, languages: {}, weapon: {} },
    skills: { his: { label: "History", reference: "Compendium.dnd5e.rules.JournalEntry.abc.JournalEntryPage.his" },
      ins: { label: "Insight" } },
    tools: { thief: { reference: "Compendium.dnd5e.rules.JournalEntry.abc.JournalEntryPage.thief" } },
    languages: { standard: { label: "Standard", children: {
      elvish: { label: "Elvish", reference: "Compendium.dnd5e.rules.JournalEntry.abc.JournalEntryPage.elvish" },
      common: "Common" } } },
    spellSchools: { evo: { label: "Evocation" } },
    spellLevels: { 0: "Cantrip", 1: "1st Level" }
  }
};

test("a trait key finds the rules page dnd5e links, where there is one", () => {
  globalThis.CONFIG = CONFIG;
  try {
    assert.match(traitReference("skills:his"), /JournalEntryPage\.his$/);
    assert.match(traitReference("tool:thief"), /JournalEntryPage\.thief$/, "the config key can differ from the trait");
    assert.match(traitReference("languages:standard:elvish"), /JournalEntryPage\.elvish$/, "nested categories");
    assert.equal(traitReference("skills:ins"), null, "documented nowhere: no explanation, no error");
    assert.equal(traitReference("languages:standard:common"), null, "a plain label, not an entry");
    assert.equal(traitReference("weapon:martial"), null);
    assert.equal(traitReference("nonsense:x"), null);
    assert.equal(traitReference(""), null);
  } finally {
    delete globalThis.CONFIG;
  }
});

test("the summary is the first sentence, as plain text", () => {
  assert.equal(firstSentence("<p>Your <b>Wisdom</b> check lets you spot things. It also helps you listen.</p>"),
    "Your Wisdom check lets you spot things.");
  assert.equal(firstSentence("<p>One line only</p>"), "One line only", "no full stop: take what there is");
  assert.equal(firstSentence(""), "");
  assert.equal(firstSentence(null), "");
  const long = `${"word ".repeat(100)}end.`;
  const cut = firstSentence(long);
  assert.ok(cut.length <= 220, `${cut.length} characters`);
  assert.ok(cut.endsWith("…"), "a long one is cut with an ellipsis");
});

test("a spell card says its level and school", () => {
  globalThis.CONFIG = CONFIG;
  try {
    assert.equal(spellMeta({ system: { level: 0, school: "evo" } }), "Cantrip · Evocation");
    assert.equal(spellMeta({ system: { level: 1, school: "evo" } }), "1st Level · Evocation");
    assert.equal(spellMeta({ system: { level: 1 } }), "1st Level", "an unknown school is left out");
    assert.equal(spellMeta(null), "");
  } finally {
    delete globalThis.CONFIG;
  }
});

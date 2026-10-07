import { test } from "node:test";
import assert from "node:assert/strict";
import { meetsPrerequisite, checkMulticlassPrerequisites, qualifyingClasses, prerequisiteFor } from "../scripts/rules/multiclass.mjs";

/* Multiclassing prerequisites (D35, PHB): 13 in the class's primary abilities, "or" or "and" as dnd5e says. */

const FIGHTER = { abilities: ["str", "dex"], all: false };
const MONK = { abilities: ["dex", "wis"], all: true };
const WIZARD = { abilities: ["int"], all: false };
const scores = over => ({ str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, ...over });

test("\"or\" needs one of them at 13, \"and\" needs all", () => {
  assert.ok(meetsPrerequisite(FIGHTER, scores({ dex: 13 })));
  assert.ok(!meetsPrerequisite(FIGHTER, scores({ str: 12, dex: 12 })));
  assert.ok(!meetsPrerequisite(MONK, scores({ dex: 14 })));
  assert.ok(meetsPrerequisite(MONK, scores({ dex: 14, wis: 13 })));
  assert.ok(meetsPrerequisite({ abilities: [], all: false }, scores()), "a class with no primary ability asks for nothing");
});

test("joining a class needs both its prerequisite and the classes already held", () => {
  const join = (primary, at, held) => ({ root: "multiclass:x", name: "X", primary, scores: scores(at), held });
  assert.deepEqual(checkMulticlassPrerequisites([join(WIZARD, { str: 13, int: 13 }, [{ root: "class", primary: FIGHTER }])]), []);
  const errs = checkMulticlassPrerequisites([join(WIZARD, { str: 12, int: 15 }, [{ root: "class", name: "Fighter", primary: FIGHTER }])]);
  assert.deepEqual(errs.map(e => e.code), ["MULTICLASS_PREREQUISITES"]);
  assert.deepEqual(errs[0].detail.missing.map(m => m.class), ["class"], "the Fighter's own 13 is what's missing");
});

test("the classes a character qualifies for next", () => {
  const candidates = [{ uuid: "wiz", primary: WIZARD }, { uuid: "monk", primary: MONK }];
  assert.deepEqual(qualifyingClasses(candidates, [{ primary: FIGHTER }], scores({ str: 15, int: 13 })), ["wiz"]);
  assert.deepEqual(qualifyingClasses(candidates, [{ primary: FIGHTER }], scores({ int: 18, dex: 13, wis: 13 })), ["wiz", "monk"]);
  assert.deepEqual(qualifyingClasses(candidates, [{ primary: FIGHTER }], scores({ int: 18 })), [],
    "nothing, when the first class's own prerequisite isn't met");
});

test("a class's own primary abilities, or the 2014 PHB table where the data names none", () => {
  assert.deepEqual(prerequisiteFor("fighter", { value: new Set(["str", "dex"]), all: false }), { abilities: ["dex", "str"], all: false });
  assert.deepEqual(prerequisiteFor("monk", { value: [], all: true }), { abilities: ["dex", "wis"], all: true }, "2014 SRD data is empty");
  assert.deepEqual(prerequisiteFor("artificer", { value: [], all: true }), { abilities: [], all: true }, "not in the PHB: nothing");
});

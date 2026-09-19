import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSegment, parseSegment, isPath, stepKey, indexRecipe, summarize } from "../scripts/rules/paths.mjs";

const ID = n => String(n).padEnd(16, "0");
const U = n => `Compendium.test.feats.Item.${ID(n)}`;

test("segments format and parse, normalising the 2014 short UUID form", () => {
  const seg = formatSegment(ID("adv"), `Compendium.test.feats.${ID("mi")}`);
  assert.equal(seg, `${ID("adv")}:${U("mi")}`);
  assert.deepEqual(parseSegment(seg), { advancementId: ID("adv"), uuid: U("mi") });
  assert.equal(parseSegment("nope"), null);
  assert.equal(parseSegment(`${ID("adv")}:Actor.${ID("x")}`), null);
});

test("paths start with a role and continue with segments", () => {
  assert.ok(isPath(["species"]));
  assert.ok(isPath(["class", `${ID("sub")}:${U("life")}`, `${ID("g")}:${U("feat")}`]));
  assert.ok(!isPath(["subclass"]));
  assert.ok(!isPath([]));
  assert.ok(!isPath(["class", "bad"]));
});

test("step keys distinguish two copies of the same item by their path", () => {
  const a = stepKey({ path: ["species", `${ID("vers")}:${U("mi")}`], advancementId: ID("spell"), level: 0 });
  const b = stepKey({ path: ["background", `${ID("grant")}:${U("mi")}`], advancementId: ID("spell"), level: 0 });
  assert.notEqual(a, b);
  const short = stepKey({ path: ["background", `${ID("grant")}:Compendium.test.feats.${ID("mi")}`], advancementId: ID("spell"), level: 0 });
  assert.equal(short, b, "UUID forms normalise to the same key");
  assert.notEqual(stepKey({ path: ["class"], advancementId: ID("x"), level: 0 }), stepKey({ path: ["class"], advancementId: ID("x"), level: 1 }));
});

test("indexRecipe keeps the first of duplicate steps and reports the rest", () => {
  const s = { path: ["class"], advancementId: ID("hp"), level: 1, data: { 1: "max" } };
  const { byKey, duplicates } = indexRecipe([s, { ...s, data: { 1: "avg" } }]);
  assert.equal(byKey.size, 1);
  assert.equal([...byKey.values()][0].data[1], "max");
  assert.equal(duplicates.length, 1);
});

test("summarize: complete only when nothing needs input, is invalid or blocked", () => {
  assert.ok(summarize([{ status: "done" }, { status: "auto" }]).complete);
  const s = summarize([{ status: "done" }, { status: "needsInput" }, { status: "blocked" }]);
  assert.equal(s.complete, false);
  assert.equal(s.needsInput.length, 1);
  assert.equal(s.blocked.length, 1);
});

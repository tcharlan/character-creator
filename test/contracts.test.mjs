import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  SCHEMA_VERSION, QUERIES, ERRORS, STEPS, LIMITS, MODULE_ID, createDraft, checkDraftShape, checkImage,
  checkSubmitPayload, checkUploadPayload, migrateDraft, MIGRATIONS, makeError, isCompendiumUuid
} from "../scripts/contracts.mjs";

const ID = n => String(n).padEnd(16, "0");
const U = n => `Compendium.test.items.Item.${ID(n)}`;

/** A well-formed draft, filled in like a finished build (synthetic ids/UUIDs, no rules content). */
function fullDraft() {
  const d = createDraft({ id: ID("draft"), worldId: "legacy-test", rules: "legacy", now: 1 });
  d.picks = { species: U("elf"), background: U("acolyte"), class: `Compendium.test.items.${ID("wizard")}` };
  d.abilities = { method: "pointBuy", base: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 }, roll: null };
  d.recipe.steps = [
    { path: ["species"], advancementId: ID("adv1"), level: 0, data: { chosen: ["skills:prc"] } },
    { path: ["background", `${ID("adv2")}:${U("feat")}`], advancementId: ID("adv3"), level: 0,
      data: { selected: [U("spell")], ability: "int" } }
  ];
  d.equipment = {
    class: { mode: "items", choices: { [ID("or1")]: ID("opt1") }, picks: { [ID("cat1")]: [U("dagger")] } },
    background: { mode: "wealth", choices: {}, picks: {}, wealth: { total: 50 } }
  };
  d.spells = { cantrips: [U("c1"), U("c2"), U("c3")], spells: [U("s1")], spellbook: [U("s1"), U("s2")] };
  d.details.name = "Aria";
  d.portrait = { status: "ready", ring: { ring: "#c9a227", background: "#1b2a49", effects: 1 },
    pendingImage: { mime: "image/webp", data: "UklGRg==", width: 512, height: 512 } };
  return d;
}
const paths = problems => problems.map(p => p.path);

test("createDraft makes a well-formed empty draft of the current schema", () => {
  const d = createDraft({ id: ID("x"), worldId: "w", rules: "modern", now: 5 });
  assert.equal(d.schema, SCHEMA_VERSION);
  assert.equal(d.status, "draft");
  assert.deepEqual(checkDraftShape(d), []);
});

test("a finished draft is well-formed and round-trips through JSON", () => {
  const d = fullDraft();
  assert.deepEqual(checkDraftShape(d), []);
  assert.deepEqual(checkDraftShape(JSON.parse(JSON.stringify(d))), []);
});

test("unknown and missing keys are reported with their path", () => {
  const d = fullDraft();
  d.extra = 1;
  delete d.picks.class;
  d.details.nickname = "x";
  assert.deepEqual(paths(checkDraftShape(d)).sort(), ["draft.details.nickname", "draft.extra", "draft.picks.class"]);
});

test("wrong values: rules, status, step, schema, scores, levels", () => {
  const d = fullDraft();
  d.rules = "2024";
  d.status = "done";
  d.step = "shop";
  d.schema = 99;
  d.abilities.base.str = 25;
  d.recipe.steps[0].level = 3;
  assert.deepEqual(paths(checkDraftShape(d)).sort(), ["draft.abilities.base.str", "draft.recipe.steps[0].level",
    "draft.rules", "draft.schema", "draft.status", "draft.step"]);
});

test("formats: ids, UUIDs, path segments, colours", () => {
  const d = fullDraft();
  d.picks.species = "Actor.abc";
  d.recipe.steps[1].path = ["background", "not-a-segment"];
  d.recipe.steps[0].path = ["wizard"];
  d.spells.cantrips = ["https://example.com/x"];
  d.portrait.ring.ring = "gold";
  d.equipment.class.choices = { bad: ID("opt1") };
  assert.deepEqual(paths(checkDraftShape(d)).sort(), ["draft.equipment.class.choices", "draft.picks.species",
    "draft.portrait.ring.ring", "draft.recipe.steps[0].path[0]", "draft.recipe.steps[1].path[1]",
    "draft.spells.cantrips[0]"]);
});

test("the 2014 short compendium UUID form is accepted (RESEARCH.md → Spike 1.1)", () => {
  assert.ok(isCompendiumUuid("Compendium.dnd5e.races.ufysTkqet2Ctmtyi"));
  assert.ok(isCompendiumUuid("Compendium.dnd5e.races.Item.ufysTkqet2Ctmtyi"));
  assert.ok(!isCompendiumUuid("Item.ufysTkqet2Ctmtyi"));
});

test("size limits: step data, text, lists, whole draft", () => {
  const d = fullDraft();
  d.recipe.steps[0].data = { chosen: ["x".repeat(LIMITS.stepDataMaxBytes)] };
  d.details.name = "n".repeat(LIMITS.nameMaxLength + 1);
  d.spells.cantrips = Array(31).fill(U("c"));
  const p = paths(checkDraftShape(d));
  for ( const want of ["draft.recipe.steps[0].data", "draft.details.name", "draft.spells.cantrips"] ) assert.ok(p.includes(want), want);
  const big = fullDraft();
  big.details.biography = "b".repeat(LIMITS.longTextMaxLength);
  big.details.appearance = "a".repeat(LIMITS.longTextMaxLength);
  big.details.traits = "t".repeat(LIMITS.longTextMaxLength);
  big.details.ideals = "i".repeat(LIMITS.longTextMaxLength);
  big.details.bonds = "o".repeat(LIMITS.longTextMaxLength);
  big.details.flaws = "f".repeat(LIMITS.longTextMaxLength);
  big.recipe.steps = Array(40).fill(big.recipe.steps[0]).map(s => ({ ...s, data: { note: "x".repeat(1000) } }));
  assert.ok(paths(checkDraftShape(big)).includes("draft"));
});

test("the pending image is checked but doesn't count toward the draft size budget", () => {
  const d = fullDraft();
  d.portrait.pendingImage = { mime: "image/webp", data: "A".repeat(700 * 1024), width: 1024, height: 1024 };  // > base64 of 512 KB
  assert.deepEqual(paths(checkDraftShape(d)), ["draft.portrait.pendingImage.data"]);
  d.portrait.pendingImage.data = "A".repeat(400 * 1024);
  assert.deepEqual(checkDraftShape(d), []);
});

test("images: WebP only, base64, within 1024 px and 512 KB", () => {
  const ok = { mime: "image/webp", data: "UklGRg==", width: 1024, height: 700 };
  assert.deepEqual(checkImage(ok), []);
  assert.deepEqual(paths(checkImage({ ...ok, mime: "image/png" })), ["image.mime"]);
  assert.deepEqual(paths(checkImage({ ...ok, width: 1025 })), ["image.width"]);
  assert.deepEqual(paths(checkImage({ ...ok, data: "not base64!" })), ["image.data"]);
});

test("submit and upload payloads", () => {
  assert.deepEqual(checkSubmitPayload({ draft: fullDraft() }), []);
  assert.deepEqual(checkSubmitPayload({ draft: fullDraft(), image: { mime: "image/webp", data: "", width: 1, height: 1 } }), []);
  assert.deepEqual(paths(checkSubmitPayload({ draft: fullDraft(), extra: 1 })), ["payload.extra"]);
  const up = { actorUuid: `Actor.${ID("a")}`, image: { mime: "image/webp", data: "UklGRg==", width: 10, height: 10 } };
  assert.deepEqual(checkUploadPayload(up), []);
  assert.deepEqual(checkUploadPayload({ ...up, ring: { ring: "#ffffff", background: null, effects: 3 } }), []);
  assert.deepEqual(paths(checkUploadPayload({ ...up, actorUuid: "Compendium.x.y.Item.1234567890123456" })), ["payload.actorUuid"]);
});

test("query names are module-prefixed", () => {
  for ( const q of Object.values(QUERIES) ) assert.ok(q.startsWith(`${MODULE_ID}.`), q);
});

test("every error code has a wizard step and an English message", async () => {
  const en = JSON.parse(await readFile(new URL("../lang/en.json", import.meta.url), "utf8"));
  for ( const e of Object.values(ERRORS) ) {
    assert.ok(STEPS.includes(e.step), `${e.code} → ${e.step}`);
    const msg = e.key.split(".").reduce((o, k) => o?.[k], en);
    assert.equal(typeof msg, "string", `missing ${e.key}`);
    assert.ok(msg.length > 5, e.key);
  }
  assert.deepEqual(makeError("SPELL_COUNT", { chosen: 3 }), { code: "SPELL_COUNT", step: "spells",
    key: "CHARCREATOR.Error.SPELL_COUNT", detail: { chosen: 3 } });
  assert.throws(() => makeError("NOPE"));
});

test("every spike validator code has a contract (codes the Phase 1 validators produce)", () => {
  const spikeCodes = ["UNKNOWN_ITEM", "UNKNOWN_ADVANCEMENT", "NOT_ALLOWED", "TOO_MANY_PICKS", "UNFULFILLED",
    "ASI_OVER_LIMIT", "ASI_LOCKED", "NOT_OFFERED", "MISSING_STEP", "APPLY_FAILED", "UNKNOWN_ENTRY_TYPE", "MISSING_CHOICE",
    "INVALID_CHOICE", "WRONG_PICK_COUNT", "NOT_IN_CATEGORY", "NOT_PROFICIENT", "UNEXPECTED_SELECTION", "BAD_MODE",
    "NO_WEALTH_OPTION", "WEALTH_OUT_OF_RANGE", "NOT_A_CASTER", "CANTRIP_COUNT", "SPELL_COUNT", "SPELLBOOK_COUNT",
    "NOT_IN_SPELLBOOK", "NOT_ON_LIST", "WRONG_LEVEL", "DUPLICATE", "ALREADY_KNOWN", "RULES_MISMATCH", "BAD_REQUEST",
    "BAD_IMAGE", "NOT_OWNER", "NO_ACTOR", "UPLOAD_FAILED", "GM_OFFLINE"];
  assert.deepEqual(spikeCodes.filter(c => !(c in ERRORS)), []);
});

test("migrateDraft: current drafts pass through; older ones step up; newer ones are refused", () => {
  const d = fullDraft();
  assert.deepEqual(migrateDraft(d), { draft: d, migrated: false });
  const v0 = { schema: 0, name: "Old" };
  const migrations = { 0: old => ({ ...createDraft({ id: ID("m"), worldId: "w", rules: "legacy", now: 0 }),
    details: { ...createDraft({ id: ID("m"), worldId: "w", rules: "legacy" }).details, name: old.name } }) };
  const { draft, migrated } = migrateDraft(v0, { migrations: { ...MIGRATIONS, ...migrations }, target: SCHEMA_VERSION });
  assert.ok(migrated);
  assert.equal(draft.schema, SCHEMA_VERSION);
  assert.equal(draft.details.name, "Old");
  assert.deepEqual(checkDraftShape(draft), []);
  assert.equal(v0.schema, 0, "the input is not modified");
  assert.throws(() => migrateDraft({ schema: SCHEMA_VERSION + 1 }), e => e.code === "SCHEMA_TOO_NEW");
  assert.throws(() => migrateDraft({ schema: 0 }), e => e.code === "BAD_REQUEST");
  assert.throws(() => migrateDraft({}), e => e.code === "BAD_REQUEST");
});

test("a draft written before hardcore mode gains its fields (schema 1 → 2, D31)", () => {
  const before = { ...fullDraft(), schema: 1 };
  delete before.mode;
  delete before.random;
  const { draft, migrated } = migrateDraft(before);
  assert.ok(migrated);
  assert.deepEqual([draft.schema, draft.mode, draft.random], [SCHEMA_VERSION, "normal", null]);
  assert.deepEqual(checkDraftShape(draft), []);
});

test("a rolled draft keeps its rolls, and only well-formed ones pass", () => {
  const d = fullDraft();
  d.mode = "hardcore";
  d.random = { messageId: ID("msg"), rolls: [{ key: "species", faces: 9, total: 4 }, { key: "class", faces: 12, total: 11 }] };
  assert.deepEqual(checkDraftShape(d), []);
  assert.deepEqual(checkDraftShape({ ...d, mode: "cheating" }).map(p => p.path), ["draft.mode"]);
  assert.ok(checkDraftShape({ ...d, random: { messageId: "nope", rolls: [] } }).length, "a bad message id is refused");
  assert.ok(checkDraftShape({ ...d, random: { messageId: ID("msg"), rolls: [{ key: "species", faces: 0, total: 1 }] } }).length,
    "a die with no faces is refused");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { DETAIL_FIELDS, createDraft, checkDraftShape, makeError } from "../scripts/contracts.mjs";
import { DETAIL_PATHS, detailsData, textToHtml, escapeHtml } from "../scripts/gm/details.mjs";
import { InFlight } from "../scripts/gm/inflight.mjs";
import { pendingDrafts, submittedDraft, processedDraft } from "../scripts/gm/pending-core.mjs";

test("every draft detail field is mapped (name and biography separately)", () => {
  const mapped = new Set([...Object.keys(DETAIL_PATHS), "name", "biography"]);
  assert.deepEqual(DETAIL_FIELDS.filter(f => !mapped.has(f)), []);
  assert.deepEqual(Object.keys(DETAIL_PATHS).filter(f => !DETAIL_FIELDS.includes(f)), []);
});

test("details become dnd5e character data; empty fields are left out", () => {
  const d = detailsData({ name: "  Tamsin ", pronouns: "she/her", alignment: "", traits: "Curious", ideals: "Knowledge",
    bonds: "My mentor", flaws: "Reckless", age: "27", biography: "" }, "fallback");
  assert.deepEqual(d, { name: "Tamsin", system: { details: { gender: "she/her", age: "27", trait: "Curious", ideal: "Knowledge",
    bond: "My mentor", flaw: "Reckless" } } });
  assert.equal(detailsData({ name: " " }, "Player A's character").name, "Player A's character");
});

test("the biography is escaped plain text in paragraphs — no HTML from the player", () => {
  assert.equal(textToHtml("First line\nsecond line\n\nNew paragraph"), "<p>First line<br>second line</p><p>New paragraph</p>");
  assert.equal(textToHtml(`<img src=x onerror="alert(1)"> & 'quotes'`),
    "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quotes&#39;</p>");
  assert.equal(textToHtml("\r\n\r\n  "), "");
  assert.equal(detailsData({ biography: "<script>x</script>" }).system.details.biography.value, "<p>&lt;script&gt;x&lt;/script&gt;</p>");
  assert.equal(escapeHtml("<>&\"'"), "&lt;&gt;&amp;&quot;&#39;");
});

test("in-flight lock: concurrent calls with one key share one run; other keys run separately", async () => {
  const lock = new InFlight();
  let runs = 0;
  let release;
  const gate = new Promise(r => release = r);
  const job = async () => {
    runs++;
    await gate;
    return `result ${runs}`;
  };
  const a = lock.run("draft1", job);
  const b = lock.run("draft1", job);
  const c = lock.run("draft2", job);
  assert.equal(a, b);
  assert.ok(lock.has("draft1"));
  release();
  assert.deepEqual(await Promise.all([a, b, c]), ["result 2", "result 2", "result 2"]);
  assert.equal(runs, 2);
  assert.ok(!lock.has("draft1"), "released after it settles");
  assert.equal(await lock.run("draft1", async () => "again"), "again");
});

test("in-flight lock: a failure is shared, then released", async () => {
  const lock = new InFlight();
  const boom = async () => {
    throw new Error("boom");
  };
  const [x, y] = [lock.run("k", boom), lock.run("k", boom)];
  await assert.rejects(x, /boom/);
  await assert.rejects(y, /boom/);
  assert.ok(!lock.has("k"));
});

/* -------------------------------------------- */
/*  Pending builds (PLAN 2.8)                   */
/* -------------------------------------------- */

const pid = n => String(n).padEnd(16, "0");
const baseDraft = (n, now) => createDraft({ id: pid(n), worldId: "w", rules: "legacy", now });
const IMAGE = { mime: "image/webp", data: "AAAA", width: 10, height: 10 };

test("pending: only players' submitted drafts, oldest first", () => {
  const users = [
    { id: "a", isGM: false, draft: submittedDraft(baseDraft("a"), null, 300) },
    { id: "b", isGM: false, draft: baseDraft("b", 100) },
    { id: "c", isGM: false, draft: null },
    { id: "g", isGM: true, draft: submittedDraft(baseDraft("g"), null, 50) },
    { id: "d", isGM: false, draft: submittedDraft(baseDraft("d"), null, 200) },
    { id: "e", isGM: false, draft: { ...baseDraft("e"), status: "failed" } }
  ];
  assert.deepEqual(pendingDrafts(users).map(p => p.userId), ["d", "a"]);
});

test("pending: a submitted draft keeps its portrait and stays well-formed", () => {
  const d = submittedDraft(baseDraft("x"), IMAGE, 5);
  assert.equal(d.status, "submitted");
  assert.deepEqual(d.portrait.pendingImage, IMAGE);
  assert.deepEqual(checkDraftShape(d), []);
});

test("pending: created drops the portrait and records the actor and warnings; failed keeps it with the errors", () => {
  const d = submittedDraft(baseDraft("x"), IMAGE, 5);
  const ok = processedDraft(d, { ok: true, actorUuid: `Actor.${pid("act")}`, warnings: [makeError("BAD_IMAGE")] }, 9);
  assert.deepEqual([ok.status, ok.portrait.pendingImage, ok.result.actorUuid, ok.result.errors.map(e => e.code)],
    ["created", null, `Actor.${pid("act")}`, ["BAD_IMAGE"]]);
  assert.deepEqual(checkDraftShape(ok), []);
  const errors = Array.from({ length: 150 }, () => makeError("MISSING_STEP"));
  const bad = processedDraft(d, { ok: false, errors }, 9);
  assert.deepEqual([bad.status, bad.result.actorUuid, bad.result.errors.length], ["failed", null, 100]);
  assert.deepEqual(bad.portrait.pendingImage, IMAGE);
  assert.deepEqual(checkDraftShape(bad), []);
});

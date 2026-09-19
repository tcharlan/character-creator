import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraft, SCHEMA_VERSION, LIMITS } from "../scripts/contracts.mjs";
import { draftState, isEditable, draftBytes, fitsBudget, Debouncer } from "../scripts/draft/state.mjs";

const ID = n => String(n).padEnd(16, "0");
const WORLD = { worldId: "legacy-test", rules: "legacy" };
const draft = over => ({ ...createDraft({ id: ID("d"), ...WORLD, now: 1 }), ...over });
const state = (d, w = WORLD) => draftState(d, w).state;

test("draft states", () => {
  assert.equal(state(null), "none");
  assert.equal(state(undefined), "none");
  assert.equal(state(draft()), "editable");
  assert.equal(state(draft({ status: "failed" })), "editable");
  assert.equal(state(draft({ status: "submitted" })), "submitted");
  assert.equal(state(draft({ status: "created" })), "created");
  assert.equal(state(draft({ worldId: "other" })), "otherWorld");
  assert.equal(state(draft({ rules: "modern" })), "otherRules");
  assert.equal(state(draft({ schema: SCHEMA_VERSION + 1 })), "tooNew");
  assert.equal(state(draft({ schema: undefined })), "broken");
  assert.equal(state(draft({ picks: 5 })), "broken");
  assert.equal(state("nonsense"), "broken");
  assert.ok(draftState(draft({ picks: 5 }), WORLD).problems.length);
});

test("an other-world or other-rules draft is still returned, so it can be shown before discarding", () => {
  assert.equal(draftState(draft({ worldId: "other" }), WORLD).draft.id, ID("d"));
  assert.equal(draftState(draft({ schema: SCHEMA_VERSION + 1 }), WORLD).draft, null);
});

test("only draft and failed drafts are editable", () => {
  assert.ok(isEditable(draft()));
  assert.ok(isEditable(draft({ status: "failed" })));
  assert.ok(!isEditable(draft({ status: "submitted" })));
  assert.ok(!isEditable(draft({ status: "created" })));
  assert.ok(!isEditable(null));
});

test("the size budget ignores the pending portrait", () => {
  const d = draft();
  const withImage = { ...d, portrait: { ...d.portrait, pendingImage: { mime: "image/webp", data: "A".repeat(600_000), width: 1, height: 1 } } };
  assert.equal(draftBytes(withImage), draftBytes(d));
  assert.ok(fitsBudget(withImage));
  const huge = draft({ details: { ...d.details, biography: "x".repeat(LIMITS.draftMaxBytes) } });
  assert.ok(!fitsBudget(huge));
});

/** A fake clock for the debouncer. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: id => timers.delete(id),
    advance(ms) {
      now += ms;
      for ( const [id, t] of [...timers] ) {
        if ( t.at <= now ) {
          timers.delete(id);
          t.fn();
        }
      }
    }
  };
}

test("debouncer: quick changes become one write of the latest value; every caller settles with it", async () => {
  const clock = fakeTimers();
  const writes = [];
  const d = new Debouncer(async v => {
    writes.push(v);
    return `wrote ${v}`;
  }, 1000, clock);
  const p1 = d.schedule(1);
  clock.advance(500);
  const p2 = d.schedule(2);
  clock.advance(900);
  assert.deepEqual(writes, []);
  assert.ok(d.pending);
  const p3 = d.schedule(3);
  clock.advance(1000);
  assert.deepEqual(await Promise.all([p1, p2, p3]), ["wrote 3", "wrote 3", "wrote 3"]);
  assert.deepEqual(writes, [3]);
  assert.ok(!d.pending);
});

test("debouncer: flush writes now; cancel drops the waiting value", async () => {
  const clock = fakeTimers();
  const writes = [];
  const d = new Debouncer(async v => writes.push(v), 1000, clock);
  const p = d.schedule("a");
  await d.flush();
  await p;
  assert.deepEqual(writes, ["a"]);
  await d.flush();
  assert.deepEqual(writes, ["a"], "nothing waiting: no write");
  const q = d.schedule("b");
  d.cancel();
  assert.equal(await q, undefined);
  clock.advance(5000);
  assert.deepEqual(writes, ["a"]);
});

test("debouncer: a failed write rejects every waiting caller", async () => {
  const clock = fakeTimers();
  const d = new Debouncer(async () => {
    throw new Error("disk full");
  }, 10, clock);
  const [a, b] = [d.schedule(1), d.schedule(2)];
  await assert.rejects(d.flush(), /disk full/);
  await assert.rejects(a, /disk full/);
  await assert.rejects(b, /disk full/);
});

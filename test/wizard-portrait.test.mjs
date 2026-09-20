import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraft, checkDraftShape } from "../scripts/contracts.mjs";
import { portraitModel, setImage, clearImage, skipPortrait, setRingColor, setRingEffects, previewUrl }
  from "../scripts/wizard/portrait-step.mjs";

const ID = n => String(n).padEnd(16, "0");
const draft = () => createDraft({ id: ID("d"), worldId: "w", rules: "legacy", now: 1 });
/** About 30 KB of base64, the size a resized portrait really is. */
const IMAGE = { mime: "image/webp", data: "AAAA".repeat(10_000), width: 512, height: 640 };

test("a new draft has no portrait and no picture in the preview", () => {
  const model = portraitModel(draft(), { userColor: "#336699" });
  assert.deepEqual([model.status, model.chosen, model.skipped, model.preview], ["none", false, false, null]);
  assert.equal(model.ring.ringShown, "#336699", "the player's own colour is the fallback");
});

test("choosing a picture stores it, with its size and dimensions shown", () => {
  const d = setImage(draft(), IMAGE);
  assert.equal(d.portrait.status, "ready");
  assert.deepEqual(d.portrait.pendingImage, IMAGE);
  const model = portraitModel(d, {});
  assert.deepEqual([model.chosen, model.dimensions], [true, "512 × 640"]);
  assert.equal(model.preview, `data:image/webp;base64,${IMAGE.data}`);
  assert.equal(previewUrl(null), null);
  assert.equal(model.size, 29, "the size is shown in KB");
  assert.deepEqual(checkDraftShape(d), []);
});

test("removing it goes back to none; skipping says so", () => {
  const d = clearImage(setImage(draft(), IMAGE));
  assert.deepEqual([d.portrait.status, d.portrait.pendingImage], ["none", null]);
  const skipped = skipPortrait(setImage(draft(), IMAGE));
  assert.deepEqual([skipped.portrait.status, skipped.portrait.pendingImage], ["skipped", null],
    "skipping drops the picture too");
  assert.equal(portraitModel(skipped, {}).skipped, true);
  assert.deepEqual(checkDraftShape(skipped), []);
});

test("ring colours take #rrggbb, and anything else clears them", () => {
  let d = setRingColor(draft(), "ring", "#C9A227");
  assert.equal(d.portrait.ring.ring, "#c9a227");
  d = setRingColor(d, "background", "not a colour");
  assert.equal(d.portrait.ring.background, null);
  d = setRingColor(d, "nonsense", "#000000");
  assert.ok(!("nonsense" in d.portrait.ring));
  const model = portraitModel(d, { defaults: { background: "#101010" } });
  assert.deepEqual([model.ring.ringShown, model.ring.backgroundShown], ["#c9a227", "#101010"],
    "the player's colour wins, then the GM's default");
  assert.deepEqual(checkDraftShape(d), []);
});

test("ring effects must be a whole number", () => {
  const d = setRingEffects(draft(), 5);
  assert.equal(d.portrait.ring.effects, 5);
  assert.equal(setRingEffects(d, "lots").portrait.ring.effects, 5, "unchanged");
  assert.equal(setRingEffects(d, -2).portrait.ring.effects, 5, "unchanged");
  assert.deepEqual(checkDraftShape(d), []);
});

test("with uploads turned off the step says so, and the limit is shown in MB", () => {
  const off = portraitModel(draft(), { enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(portraitModel(draft(), { maxSourceBytes: 10 * 1024 * 1024 }).maxMB, 10);
  assert.equal(portraitModel(draft(), {}).maxMB, null);
});

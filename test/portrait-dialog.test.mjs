import { test } from "node:test";
import assert from "node:assert/strict";
import { dialogState, dialogModel, setDialogImage, setDialogRing, blockedBy, imageUrl }
  from "../scripts/portrait/portrait-model.mjs";

// 4 KB of base64 is 3 KB of picture.
const image = { mime: "image/webp", data: "A".repeat(4096), width: 819, height: 1024 };
const base = { name: "Brenna", current: "icons/svg/mystery-man.svg" };

test("nothing chosen yet: the character's own picture, and no way to save", () => {
  const model = dialogModel(dialogState(), base);
  assert.equal(model.preview, base.current);
  assert.deepEqual([model.chosen, model.canSave, model.canChoose], [false, false, true]);
  assert.equal(model.blocked, null);
  assert.equal(model.size, null);
});

test("a chosen picture is previewed, with its size, and can be saved", () => {
  const state = setDialogImage(dialogState(), image);
  const model = dialogModel(state, { ...base, maxSourceBytes: 10 * 1024 * 1024 });
  assert.equal(model.preview, imageUrl(image));
  assert.deepEqual([model.chosen, model.canSave], [true, true]);
  assert.equal(model.dimensions, "819 × 1024");
  assert.equal(model.size, 3, "kilobytes of the encoded picture");
  assert.equal(model.maxMB, 10);
  assert.equal(dialogModel(setDialogImage(state, null), base).chosen, false, "and it can be taken out again");
});

test("what stops it, in the order the player should hear it", () => {
  assert.equal(blockedBy({}), null);
  assert.equal(blockedBy({ isOwner: false, uploads: false, gmOnline: false }), "NOT_OWNER");
  assert.equal(blockedBy({ uploads: false, gmOnline: false }), "UPLOADS_DISABLED");
  assert.equal(blockedBy({ gmOnline: false }), "GM_OFFLINE", "A5: this one can't wait in the queue");
  const model = dialogModel(setDialogImage(dialogState(), image), { ...base, gmOnline: false });
  assert.deepEqual([model.canSave, model.canChoose], [false, false]);
  assert.equal(model.blockedKey, "CHARCREATOR.Error.GM_OFFLINE");
});

test("ring colours: the player's choice, then the GM's default, then the player's own colour", () => {
  const state = setDialogImage(dialogState({ ring: "#112233", effects: 2 }), image);
  assert.equal(dialogModel(state, base).ring.ringPaint, "#112233", "what the character already has");
  const cleared = setDialogRing(state, "ring", "");
  assert.equal(cleared.ring.ring, null);
  assert.equal(dialogModel(cleared, { ...base, defaults: { ring: "#aabbcc" } }).ring.ringPaint, "#aabbcc");
  assert.equal(dialogModel(cleared, { ...base, userColor: "#ddeeff" }).ring.ringPaint, "#ddeeff");
  assert.equal(dialogModel(cleared, base).ring.ringPaint, null);
  assert.equal(setDialogRing(cleared, "nonsense", "#000000").ring.ring, null, "only the two colours");
  assert.equal(state.ring.effects, 2, "whatever effects the character already had are kept");
});

test("while it saves, nothing else can be pressed", () => {
  const state = setDialogImage(dialogState(), image);
  state.saving = true;
  const model = dialogModel(state, base);
  assert.deepEqual([model.saving, model.canSave, model.canChoose], [true, false, false]);
  assert.equal(imageUrl(null), null);
});

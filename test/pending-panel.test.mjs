import { test } from "node:test";
import assert from "node:assert/strict";
import { queueRows, queueCounts, pendingModel } from "../scripts/gm/pending-model.mjs";
import { STATUS } from "../scripts/contracts.mjs";

const ID = n => String(n).padEnd(16, "0");
const U = n => `Compendium.dnd5e.classes.Item.${ID(n)}`;
const NAMES = { [U("elf")]: "High Elf", [U("cleric")]: "Cleric", [U("acolyte")]: "Acolyte" };
const names = uuid => NAMES[uuid] ?? null;

const draft = (over = {}) => ({
  id: ID("d"), status: STATUS.SUBMITTED, updatedAt: 100,
  picks: { species: U("elf"), class: U("cleric"), background: U("acolyte") },
  details: { name: "Brenna" }, portrait: { pendingImage: null }, result: { actorUuid: null, errors: [] }, ...over
});
const user = (id, over = {}) => ({ id, name: `Player ${id}`, isGM: false, draft: draft(), ...over });

test("only what a GM still has to do is listed: waiting first, oldest first", () => {
  const rows = queueRows([
    user("a", { draft: draft({ updatedAt: 300 }) }),
    user("gm", { isGM: true, draft: draft() }),
    user("b", { draft: null }),
    user("c", { draft: draft({ status: STATUS.DRAFT }) }),
    user("d", { draft: draft({ status: STATUS.CREATED, result: { actorUuid: `Actor.${ID("a")}`, errors: [] } }) }),
    user("e", { draft: draft({ updatedAt: 200 }) }),
    user("f", { draft: draft({ status: STATUS.FAILED, updatedAt: 50,
      result: { actorUuid: null, errors: [{ code: "CANTRIP_COUNT", key: "CHARCREATOR.Error.CANTRIP_COUNT", step: "spells" }] } }) })
  ], { names });
  assert.deepEqual(rows.map(r => [r.userId, r.kind]), [["e", "waiting"], ["a", "waiting"], ["f", "failed"]],
    "a GM's own draft, a draft still being written and a finished one are not a GM's business");
  assert.deepEqual(rows[0].picks, ["High Elf", "Cleric", "Acolyte"]);
  assert.equal(rows[0].character, "Brenna");
  assert.deepEqual(rows[2].errors, [{ code: "CANTRIP_COUNT", key: "CHARCREATOR.Error.CANTRIP_COUNT", step: "spells" }]);
  assert.deepEqual(queueCounts(rows), { waiting: 2, failed: 1, total: 3 });
  assert.deepEqual(queueRows([], {}), []);
  assert.deepEqual(queueRows(undefined), []);
});

test("a waiting build can be created; a refused one can only be tried again", () => {
  const rows = queueRows([
    user("a"),
    user("b", { draft: draft({ status: STATUS.FAILED, details: { name: "  " }, portrait: { pendingImage: null },
      result: { actorUuid: null, errors: [{ code: "NAME_REQUIRED", key: "CHARCREATOR.Error.NAME_REQUIRED", step: "details" }] } }) })
  ], { names });
  const model = pendingModel(rows);
  assert.deepEqual(model.rows.map(r => [r.canCreate, r.canRetry]), [[true, false], [false, true]]);
  assert.equal(model.rows[0].picksText, "High Elf · Cleric · Acolyte");
  assert.equal(model.rows[1].character, "", "an unnamed character shows as such on screen");
  assert.equal(model.empty, false);
  assert.deepEqual(model.counts, { waiting: 1, failed: 1, total: 2 });

  const busy = pendingModel(rows, { busy: "a" });
  assert.deepEqual(busy.rows.map(r => r.busy), [true, false]);
  assert.equal(pendingModel([]).empty, true);
});

test("a portrait waiting with the build is worth saying", () => {
  const withImage = queueRows([user("a", { draft: draft({ portrait: { pendingImage: { mime: "image/webp" } } }) })], { names });
  assert.equal(withImage[0].hasPortrait, true);
  assert.equal(queueRows([user("b")], { names })[0].hasPortrait, false);
});

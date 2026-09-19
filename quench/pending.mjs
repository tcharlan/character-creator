import { MODULE_ID } from "../scripts/main.mjs";
import { DRAFT_FLAG } from "../scripts/contracts.mjs";
import { ABILITY_TEST_QUERIES } from "./abilities.mjs";
import { SUBMIT_TEST_QUERIES } from "./submit.mjs";
import { legitDraft } from "./validator.mjs";

/*
 * Pending builds (PLAN 2.8, D17). Two batches that run in sequence:
 * - `pending@nogm` runs while no GM is online (the runner's player-only phase): Player A submits, and the
 *   draft is stored as `submitted` with its portrait.
 * - `pending@gm` runs first once the Gamemaster has joined: the GM's processor has created the character
 *   on `ready`; then a tampered pending draft fails, and a draft whose actor already exists is only marked.
 * Registered before the other batches so `pending@gm` is the first GM batch (nothing else touches Player A's
 * characters before it).
 */

const FIXED = {
  legacy: { species: "High Elf", background: "Acolyte", class: "Wizard" },
  modern: { species: "Human", background: "Sage", class: "Cleric" }
};
const flag = () => game.user.getFlag(MODULE_ID, DRAFT_FLAG) ?? null;

/** Wait until the player's draft leaves `submitted` (the GM's processor has run). */
async function settled(timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while ( Date.now() < end ) {
    const d = flag();
    if ( d && d.status !== "submitted" ) return d;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`draft still ${flag()?.status ?? "missing"} after ${timeoutMs / 1000}s`);
}

export function registerPendingBatches(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.pending@nogm`, ({ describe, it, assert }) => {
    describe("Pending builds, part 1: submitting with no GM online", () => {
      it("with no GM online, the draft is stored as submitted, portrait included", async function() {
        this.timeout(180_000);
        assert.notExists(game.users.activeGM, "this batch needs no GM online (npm run test:foundry runs it first)");
        const S = await import("./support.mjs");
        const { preparePortrait } = await import("../scripts/portrait/prepare.mjs");
        const { submitDraft } = await import("../scripts/gm/pending.mjs");
        const catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        const draft = await legitDraft(FIXED[rules()], { catalog });
        const image = await preparePortrait(await S.makeTestImage(800, 800));
        const res = await submitDraft(draft, { image });
        assert.deepEqual(res, { ok: true, pending: true });
        const stored = flag();
        assert.equal(stored.id, draft.id);
        assert.equal(stored.status, "submitted");
        assert.deepEqual(stored.portrait.pendingImage, image);
        const { checkDraftShape } = await import("../scripts/contracts.mjs");
        assert.deepEqual(checkDraftShape(stored), []);
      });
    });
  }, { displayName: "Character Creator: Pending builds (no GM)" });

  quench.registerBatch(`${MODULE_ID}.pending@gm`, ({ describe, it, before, after, assert }) => {
    describe("Pending builds, part 2: the GM joins", () => {
      let submitted;
      let created;
      const gm = () => game.users.activeGM;
      const mine = () => game.actors.filter(a => a.getFlag(MODULE_ID, "created")?.userId === game.user.id);

      before(async function() {
        this.timeout(120_000);
        assert.exists(gm(), "no active GM — run with npm run test:foundry");
        submitted = flag();
        assert.exists(submitted, "no draft — run pending@nogm first (npm run test:foundry -- --batch pending)");
      });
      after(async function() {
        this.timeout(60_000);
        if ( gm() ) {
          await gm().query(SUBMIT_TEST_QUERIES.CLEANUP, {}, { timeout: 60_000 });
          if ( submitted ) await gm().query(ABILITY_TEST_QUERIES.CLEANUP, { draftIds: [submitted.id] }, { timeout: 30_000 });
        }
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
      });

      it("when the GM joins, the pending build is created and the draft marked created (portrait dropped)", async function() {
        this.timeout(120_000);
        const d = await settled();
        assert.equal(d.status, "created", JSON.stringify(d.result.errors).slice(0, 300));
        assert.deepEqual(d.result.errors, []);
        assert.isNull(d.portrait.pendingImage);
        created = await fromUuid(d.result.actorUuid);
        assert.exists(created);
        assert.lengthOf(mine(), 1);
        assert.equal(created.getFlag(MODULE_ID, "created").draftId, submitted.id);
        assert.isTrue(created.isOwner);
        assert.equal(game.user.character?.id, created.id);
        assert.match(created.img, new RegExp(`assets/actors/${created.id}-[^/]+\\.webp$`), "the pending portrait was saved");
      });
      it("a tampered pending draft is marked failed with its errors, and nothing is created", async function() {
        this.timeout(120_000);
        const { submittedDraft } = await import("../scripts/gm/pending-core.mjs");
        const { writeDraft } = await import("../scripts/gm/pending.mjs");
        const bad = submittedDraft({ ...foundry.utils.deepClone(submitted), id: foundry.utils.randomID() }, null);
        bad.recipe.steps.pop();
        await writeDraft(game.user, bad);
        const d = await settled();
        assert.equal(d.status, "failed");
        assert.include(d.result.errors.map(e => e.code), "MISSING_STEP");
        assert.isNull(d.result.actorUuid);
        assert.lengthOf(mine(), 1);
      });
      it("a pending draft whose character already exists is only marked created (no duplicate)", async function() {
        this.timeout(120_000);
        const { submittedDraft } = await import("../scripts/gm/pending-core.mjs");
        const { writeDraft } = await import("../scripts/gm/pending.mjs");
        await writeDraft(game.user, submittedDraft(foundry.utils.deepClone(submitted), null));
        const d = await settled();
        assert.equal(d.status, "created");
        assert.equal(d.result.actorUuid, created.uuid);
        assert.lengthOf(mine(), 1);
      });
      it("with a GM online, submitDraft goes straight to the GM (live path, no pending build)", async function() {
        this.timeout(120_000);
        const { submitDraft } = await import("../scripts/gm/pending.mjs");
        const res = await submitDraft(foundry.utils.deepClone(submitted));
        assert.deepEqual([res.ok, res.duplicate, res.actorUuid], [true, true, created.uuid]);
        assert.notEqual(flag()?.status, "submitted");
      });
    });
  }, { displayName: "Character Creator: Pending builds (GM joins)" });
}

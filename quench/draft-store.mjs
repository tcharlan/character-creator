import { MODULE_ID } from "../scripts/main.mjs";
import { DRAFT_FLAG, SCHEMA_VERSION } from "../scripts/contracts.mjs";

/*
 * Draft store (PLAN 2.9) on Player A's own user flag: round trip, debounced autosave, refusals, world/rules
 * guards, discard, read-only submitted drafts, acknowledging results. `draft-store@gm`: the GM's pending
 * processor leaves drafts that aren't submitted alone.
 */

const flag = () => game.user.getFlag(MODULE_ID, DRAFT_FLAG);
const raw = value => game.user.update({ [`flags.${MODULE_ID}.${DRAFT_FLAG}`]: foundry.data.operators.ForcedReplacement.create(value) });
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function registerDraftStoreBatches(quench) {
  quench.registerBatch(`${MODULE_ID}.draft-store`, ({ describe, it, before, after, assert }) => {
    describe("Draft store (scripts/draft/store.mjs), as Player A", () => {
      let DraftStore;
      let saved;

      before(async () => {
        ({ DraftStore } = await import("../scripts/draft/store.mjs"));
        saved = flag();
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
      });
      after(async () => {
        if ( saved === undefined ) await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        else await raw(saved);
      });

      it("no draft → none; create() stores a new one for this world and rules", async () => {
        const store = new DraftStore();
        assert.equal(store.load().state, "none");
        const d = await store.create();
        assert.deepEqual(flag(), d);
        assert.equal(d.worldId, game.world.id);
        assert.equal(d.rules, game.settings.get("dnd5e", "rulesVersion"));
        assert.equal(new DraftStore().load().state, "editable");
      });
      it("round trip: an update is autosaved and loads back identically", async () => {
        const store = new DraftStore(game.user, { delay: 50 });
        store.load();
        await store.update(d => {
          d.details.name = "Round Trip";
          d.abilities = { method: "standardArray", base: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, roll: null };
        });
        const again = new DraftStore();
        const { state, draft } = again.load();
        assert.equal(state, "editable");
        assert.equal(draft.details.name, "Round Trip");
        assert.deepEqual(draft, store.draft);
      });
      it("rapid edits are coalesced into one database write", async function() {
        this.timeout(10_000);
        const store = new DraftStore(game.user, { delay: 300 });
        store.load();
        let writes = 0;
        const id = Hooks.on("preUpdateUser", (u, changes) => {
          if ( u.isSelf && foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${DRAFT_FLAG}`) ) writes++;
        });
        try {
          const saves = [];
          for ( let i = 0; i < 10; i++ ) {
            saves.push(store.update(d => d.details.name = `Name ${i}`));
            await sleep(20);
          }
          assert.isTrue(store.pending);
          await Promise.all(saves);
        } finally {
          Hooks.off("preUpdateUser", id);
        }
        assert.equal(writes, 1);
        assert.equal(flag().details.name, "Name 9");
      });
      it("flush() writes a waiting autosave at once", async () => {
        const store = new DraftStore(game.user, { delay: 60_000 });
        store.load();
        const p = store.update(d => d.details.name = "Flushed");
        assert.notEqual(flag().details.name, "Flushed");
        await store.flush();
        await p;
        assert.equal(flag().details.name, "Flushed");
      });
      it("a malformed or oversized draft is refused and the stored one is kept", async () => {
        const store = new DraftStore(game.user, { delay: 10 });
        store.load();
        const before = flag();
        let err = await store.update(d => d.picks = 5).catch(e => e);
        assert.equal(err?.error?.code, "BAD_REQUEST");
        err = await store.update(d => d.details.biography = "x".repeat(70_000)).catch(e => e);
        assert.equal(err?.error?.code, "BAD_REQUEST");
        assert.match(JSON.stringify(err.error.detail), /larger than|longer than/);
        assert.deepEqual(flag(), before);
      });
      it("a draft from another world or rules version can't resume; a newer schema is kept; junk is broken", async () => {
        const d = flag();
        await raw({ ...d, worldId: "another-world" });
        assert.equal(new DraftStore().load().state, "otherWorld");
        await raw({ ...d, rules: d.rules === "legacy" ? "modern" : "legacy" });
        const other = new DraftStore();
        assert.equal(other.load().state, "otherRules");
        assert.isNull(other.draft, "not editable here");
        assert.equal((await other.update(x => x).catch(e => e))?.error?.code, "ALREADY_SUBMITTED");
        await raw({ ...d, schema: SCHEMA_VERSION + 1 });
        assert.equal(new DraftStore().load().state, "tooNew");
        await raw({ nonsense: true });
        assert.equal(new DraftStore().load().state, "broken");
        await raw(d);
      });
      it("submitted drafts are read-only; the store won't overwrite one a GM is handling", async () => {
        const store = new DraftStore(game.user, { delay: 10 });
        store.load();
        const d = flag();
        const { submittedDraft } = await import("../scripts/gm/pending-core.mjs");
        // Another tab (or submitDraft) marks it submitted after this store loaded it.
        await raw(submittedDraft(d, null));
        const err = await store.update(x => x.details.name = "Too late").catch(e => e);
        assert.equal(err?.error?.code, "ALREADY_SUBMITTED");
        assert.equal(flag().status, "submitted");
        const fresh = new DraftStore();
        assert.equal(fresh.load().state, "submitted");
        assert.isNull(fresh.draft);
        await raw(d);
      });
      it("acknowledge: a failed draft returns to editing; a created one is cleared", async () => {
        const d = flag();
        await raw({ ...d, status: "failed", result: { actorUuid: null, errors: [{ code: "MISSING_STEP", step: "choices",
          key: "CHARCREATOR.Error.MISSING_STEP" }] } });
        const store = new DraftStore();
        const back = await store.acknowledge();
        assert.equal(back.status, "draft");
        assert.deepEqual(flag().result, { actorUuid: null, errors: [] });
        await raw({ ...d, status: "created", result: { actorUuid: `Actor.${foundry.utils.randomID()}`, errors: [] } });
        assert.isNull(await new DraftStore().acknowledge());
        assert.isUndefined(flag());
        await raw(d);
      });
      it("discard removes the draft and its pending portrait; a waiting autosave is dropped", async () => {
        const store = new DraftStore(game.user, { delay: 200 });
        store.load();
        await store.update(d => d.portrait.pendingImage = { mime: "image/webp", data: "AAAA", width: 1, height: 1 });
        const late = store.update(d => d.details.name = "Never written");
        await store.discard();
        await late;
        await sleep(400);
        assert.isUndefined(flag());
        assert.equal(new DraftStore().load().state, "none");
      });
    });
  }, { displayName: "Character Creator: Draft store" });

  quench.registerBatch(`${MODULE_ID}.draft-store@gm`, ({ describe, it, after, assert }) => {
    describe("Draft store with a GM online", () => {
      after(async () => game.user.unsetFlag(MODULE_ID, DRAFT_FLAG));
      it("the GM's pending processor leaves drafts that aren't submitted alone", async function() {
        this.timeout(30_000);
        assert.exists(game.users.activeGM, "no active GM — run with npm run test:foundry");
        const { DraftStore } = await import("../scripts/draft/store.mjs");
        const store = new DraftStore(game.user, { delay: 10 });
        await store.create();
        await store.update(d => d.details.name = "Still a draft");
        await sleep(3000);
        const d = flag();
        assert.equal(d.status, "draft");
        assert.equal(d.details.name, "Still a draft");
        assert.deepEqual(d.result, { actorUuid: null, errors: [] });
      });
    });
  }, { displayName: "Character Creator: Draft store (GM online)" });
}

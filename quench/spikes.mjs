import { MODULE_ID } from "../scripts/main.mjs";

/*
 * Phase 1 spike checks as Quench batches, so `npm run test:foundry` runs them unattended.
 * They import the throwaway spike code; Phase 2 replaces both with the real rules adapter and its tests.
 */

const ADVANCEMENT_TYPES = ["AbilityScoreImprovement", "HitPoints", "ItemChoice", "ItemGrant", "ScaleValue",
  "Size", "Subclass", "Trait"];

/** Types the spike 1.1 picks don't use at level 1 in a rule set (RESEARCH.md → Spike 1.1). */
const NOT_USED = { legacy: ["ItemChoice"], modern: ["Subclass"] };

/** Check ids spike 1.2 reports per rule set. */
const CHECKS_1_2 = {
  legacy: ["D1", "L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10", "L11", "G1"],
  modern: ["D1", "M1", "M2", "M3", "M4", "M4b", "M5", "M6", "M7", "M8", "M9", "G1"]
};

const rules = () => game.settings.get("dnd5e", "rulesVersion");
const brief = value => JSON.stringify(value)?.slice(0, 1500);

export function registerSpikeBatches(quench) {
  quench.registerBatch(`${MODULE_ID}.spike-1-1`, ({ describe, it, before, assert }) => {
    describe("Spike 1.1 — every advancement type applies on an unsaved actor", () => {
      let report;
      let initialsBefore;
      before(async function() {
        this.timeout(120_000);
        const lib = await import("../spike/lib.mjs");
        initialsBefore = lib.schemaInitials();
        report = await (await import("../spike/advancement-apply.mjs")).run();
      });

      it("writes nothing to the database", () => {
        assert.deepEqual(report.dbWrites, [], brief(report.dbWrites));
        assert.isTrue(report.actorsUnchanged);
        assert.isTrue(report.final?.stillUnsaved);
      });
      it("applies every advancement without error", () => {
        assert.deepEqual(report.errors, [], brief(report.errors));
        assert.deepEqual(report.steps.filter(s => s.error).map(s => [s.item, s.type, s.error.message]), []);
      });
      for ( const type of ADVANCEMENT_TYPES ) {
        it(`covers ${type}`, function() {
          if ( NOT_USED[rules()]?.includes(type) ) this.skip();
          assert.include(report.typesSeen, type);
        });
      }
      it("leaves schema defaults untouched", async () => {
        const after = (await import("../spike/lib.mjs")).schemaInitials();
        const changed = Object.keys(initialsBefore).filter(k => initialsBefore[k] !== after[k]);
        assert.deepEqual(changed, []);
      });
    });
  }, { displayName: "Character Creator: Spike 1.1" });

  quench.registerBatch(`${MODULE_ID}.spike-1-2`, ({ describe, it, before, assert }) => {
    describe("Spike 1.2 — order, reverse and re-apply", () => {
      let report;
      before(async function() {
        this.timeout(300_000);
        report = await (await import("../spike/order-reverse.mjs")).run();
      });

      it("writes nothing to the database and throws nothing", () => {
        assert.deepEqual(report.dbWrites, [], brief(report.dbWrites));
        assert.deepEqual(report.errors, [], brief(report.errors));
        assert.deepEqual(report.stepErrors, [], brief(report.stepErrors));
      });
      const ids = [...new Set([...CHECKS_1_2.legacy, ...CHECKS_1_2.modern])];
      for ( const id of ids ) {
        it(`check ${id} is as expected`, function() {
          if ( !CHECKS_1_2[rules()]?.includes(id) ) this.skip();
          const check = report.checks.find(c => c.id === id);
          assert.exists(check, `check ${id} did not run`);
          assert.isTrue(check.ok, `${check.name ?? id}: ${check.error ?? brief(check.differences ?? check)}`);
        });
      }
    });
  }, { displayName: "Character Creator: Spike 1.2" });

  quench.registerBatch(`${MODULE_ID}.spike-1-3`, ({ describe, it, before, assert }) => {
    describe("Spike 1.3 — replay from the recipe, tamper detection, timing", () => {
      let report;
      before(async function() {
        this.timeout(300_000);
        report = await (await import("../spike/replay.mjs")).run();
      });

      it("writes nothing to the database and throws nothing", () => {
        assert.deepEqual(report.dbWrites, [], brief(report.dbWrites));
        assert.deepEqual(report.errors, [], brief(report.errors));
      });
      const ids = ["R0", "R1", "R2", "T1", "T2", "T3", "T3b", "T4", "T4b", "T5", "T6", "P1", "G1"];
      for ( const id of ids ) {
        it(`check ${id}`, function() {
          const check = report.checks.find(c => c.id === id);
          if ( !check && !["R0", "R1", "R2", "P1", "G1"].includes(id) && !report.tamperIds?.includes(id) ) this.skip();
          assert.exists(check, `check ${id} did not run`);
          assert.isTrue(check.ok, `${check.name}: ${brief(check.errors ?? check.differences ?? check)}`);
        });
      }
      it("reports the timing", () => {
        assert.exists(report.timing);
        const tampers = report.checks.filter(c => c.id.startsWith("T"))
          .map(c => ({ id: c.id, codes: (c.errors ?? []).map(e => `${e.code}@${e.step}: ${JSON.stringify(e.detail)}`.slice(0, 160)) }));
        console.log(`character-creator | spike 1.3 summary (${rules()}): ${JSON.stringify({
          timing: report.timing, recipeBytes: report.recipeBytes, recipeSteps: report.recipeSteps, tampers })}`);
      });
    });
  }, { displayName: "Character Creator: Spike 1.3" });

  // Needs a GM online (key ends in "@gm"): the runner opens a Gamemaster session alongside Player A.
  quench.registerBatch(`${MODULE_ID}.spike-1-4@gm`, ({ describe, it, before, after, assert }) => {
    describe("Spike 1.4 — player submits, active GM validates and creates", () => {
      let lib;
      let replayMod;
      let submit;
      let built;
      let recipe;
      const draftId = foundry.utils.randomID();
      let result;
      let playerWrites;
      let actor;
      const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
      const query = (name, data) => game.users.activeGM.query(name, data, { timeout: 30_000 });
      const waitFor = async (fn, ms = 10_000) => {
        const end = Date.now() + ms;
        while ( Date.now() < end ) {
          const v = fn();
          if ( v ) return v;
          await new Promise(r => setTimeout(r, 100));
        }
        return null;
      };
      const spikeActors = () => game.actors.filter(a => a.getFlag(MODULE_ID, "spike14"));

      before(async function() {
        this.timeout(120_000);
        lib = await import("../spike/lib.mjs");
        replayMod = await import("../spike/replay.mjs");
        submit = await import("../spike/submit.mjs");
        assert.exists(game.users.activeGM, "no active GM — run with npm run test:foundry");
        await query(submit.CLEANUP, {});
        built = await lib.buildCharacter(rules());
        recipe = JSON.parse(JSON.stringify(replayMod.extractRecipe(built, rules())));
      });
      after(async function() {
        this.timeout(60_000);
        if ( submit && game.users.activeGM ) await query(submit.CLEANUP, {});
      });

      it("runs as a Player-role user with a GM online", () => {
        assert.isFalse(game.user.isGM);
        assert.equal(game.user.role, CONST.USER_ROLES.PLAYER);
        assert.isTrue(game.users.activeGM.active);
      });

      it("a player cannot create an actor directly (D13)", async () => {
        const before = game.actors.size;
        let threw;
        try {
          const a = await Actor.implementation.create({ name: "should not exist", type: "character" });
          threw = !a;
        } catch {
          threw = true;
        }
        assert.isTrue(threw, "Actor.create should fail for a Player");
        assert.equal(game.actors.size, before);
      });

      it("submit → the GM creates the actor", async function() {
        this.timeout(60_000);
        const stop = lib.watchDb();
        const actorsBefore = game.actors.size;
        const t0 = performance.now();
        result = await query(submit.SUBMIT, { recipe, draftId, name: "Spike 1.4 Hero" });
        result.roundTripMs = Math.round(performance.now() - t0);
        // The watcher also flags a changed game.actors size — expected here (the GM's actor arrives).
        playerWrites = stop().filter(w => w.hook !== "game.actors.size changed");
        result.actorsAdded = () => game.actors.size - actorsBefore;
        assert.isTrue(result.ok, JSON.stringify(result.errors));
        actor = await waitFor(() => fromUuidSync(result.actorUuid));
        assert.exists(actor, "the created actor never reached the player");
        console.log(`${MODULE_ID} | spike 1.4 submit (${rules()}): ${JSON.stringify({
          roundTripMs: result.roundTripMs, ...result.diagnostics })}`);
      });

      it("the player's own client wrote nothing; exactly one actor arrived from the GM", () => {
        assert.deepEqual(playerWrites, [], JSON.stringify(playerWrites));
        assert.equal(result.actorsAdded(), 1);
      });

      it("creating the actor opened no windows on the GM (no AdvancementManager)", () => {
        assert.deepEqual(result.diagnostics.opened, []);
      });

      it("the created actor ≡ the player's build", () => {
        const r = lib.compare(lib.snapshot(actor), lib.snapshot(built.actor));
        assert.isTrue(r.equal, JSON.stringify(r.differences).slice(0, 1500));
      });

      it("the player owns it; nobody else does by default", () => {
        assert.equal(actor.ownership[game.user.id], OWNER);
        assert.equal(actor.ownership.default, CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE);
        assert.isTrue(actor.isOwner);
      });

      it("it is assigned as the player's character", async () => {
        const assigned = await waitFor(() => game.user.character?.id === actor.id);
        assert.isTrue(!!assigned, `user.character is ${game.user.character?.id}`);
      });

      it("resubmitting the same draft does not duplicate it", async () => {
        const again = await query(submit.SUBMIT, { recipe, draftId });
        assert.isTrue(again.ok);
        assert.isTrue(again.duplicate);
        assert.equal(again.actorUuid, result.actorUuid);
        assert.lengthOf(spikeActors(), 1);
      });

      it("a tampered recipe is rejected and nothing is created", async () => {
        const tampered = foundry.utils.deepClone(recipe);
        const skills = tampered.steps.find(s => s.data?.chosen?.some(k => k.startsWith("skills:"))
          && s.item === recipe.picks.class);
        skills.data.chosen.push("skills:ste");
        const res = await query(submit.SUBMIT, { recipe: tampered, draftId: foundry.utils.randomID() });
        assert.isFalse(res.ok);
        assert.isTrue(res.errors.some(e => ["TOO_MANY_PICKS", "NOT_ALLOWED"].includes(e.code)), JSON.stringify(res.errors));
        assert.lengthOf(spikeActors(), 1);
      });

      it("a recipe for the other rule set is rejected", async () => {
        const other = { ...recipe, rules: rules() === "legacy" ? "modern" : "legacy" };
        const res = await query(submit.SUBMIT, { recipe: other, draftId: foundry.utils.randomID() });
        assert.isFalse(res.ok);
        assert.equal(res.errors[0].code, "RULES_MISMATCH");
      });

      it("clean-up removes the spike actor and the assignment", async function() {
        this.timeout(30_000);
        const res = await query(submit.CLEANUP, {});
        assert.equal(res.deleted, 1);
        assert.isTrue(!!(await waitFor(() => !spikeActors().length && !game.user.character)));
      });
    });
  }, { displayName: "Character Creator: Spike 1.4 (needs GM)" });
}

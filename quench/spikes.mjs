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
}

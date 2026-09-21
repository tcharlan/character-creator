import { MODULE_ID } from "../scripts/main.mjs";
import { DRAFT_FLAG } from "../scripts/contracts.mjs";
import { legitDraft } from "./validator.mjs";

/*
 * How long things take (PLAN 5.4): reading the compendium indexes, and the wizard opening — on a new draft and
 * on a finished one being resumed. The numbers are logged so a run on a bigger world can be compared, and the
 * budgets are the ones in PLAN 5.4.
 */

const FIXED = {
  legacy: { species: "Hill Dwarf", background: "Acolyte", class: "Cleric" },
  modern: { species: "Human", background: "Sage", class: "Cleric" }
};
const OPEN_BUDGET_MS = 1000;

export function registerPerformanceBatches(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.performance`, ({ describe, it, before, after, afterEach, assert }) => {
    describe("Performance (PLAN 5.4), as Player A", () => {
      let CharacterWizard;
      let C;
      let saved;
      let app = null;
      const numbers = {};
      const time = async fn => {
        const t0 = performance.now();
        const value = await fn();
        return { value, ms: Math.round(performance.now() - t0) };
      };

      before(async function() {
        this.timeout(120_000);
        ({ CharacterWizard } = await import("../scripts/wizard/app.mjs"));
        C = await import("../scripts/catalog/catalog.mjs");
        saved = game.user.getFlag(MODULE_ID, DRAFT_FLAG);
      });
      afterEach(async function() {
        this.timeout(60_000);
        if ( app?.rendered ) await app.close();
        app = null;
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
      });
      after(async function() {
        this.timeout(60_000);
        console.log(`${MODULE_ID} | performance (${rules()}): ${JSON.stringify(numbers)}`);
        if ( saved !== undefined ) {
          await game.user.update({ [`flags.${MODULE_ID}.${DRAFT_FLAG}`]:
            foundry.data.operators.ForcedReplacement.create(saved) });
        }
      });

      it("reads the compendium indexes once, and hands out the cached catalog after that", async function() {
        this.timeout(120_000);
        C.invalidateCatalog("performance test");
        const cold = await time(() => C.getCatalog());
        const warm = await time(() => C.getCatalog());
        numbers.catalogCold = cold.ms;
        numbers.catalogWarm = warm.ms;
        numbers.entries = cold.value.stats.entries;
        numbers.packs = cold.value.stats.packsRead;
        assert.equal(warm.value, cold.value, "the same catalog, not a second one");
        assert.isBelow(warm.ms, 50, "a cached catalog is handed out at once");
      });

      it(`opens on a new draft in under ${OPEN_BUDGET_MS} ms`, async function() {
        this.timeout(120_000);
        await C.getCatalog();
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        const opened = await time(() => CharacterWizard.open());
        app = opened.value;
        numbers.openNew = opened.ms;
        assert.exists(app);
        assert.isBelow(opened.ms, OPEN_BUDGET_MS);
      });

      it(`resumes a finished character in under ${OPEN_BUDGET_MS} ms`, async function() {
        this.timeout(300_000);
        const catalog = await C.getCatalog();
        const draft = await legitDraft(FIXED[rules()], { catalog });
        draft.step = "review";
        await game.user.update({ [`flags.${MODULE_ID}.${DRAFT_FLAG}`]:
          foundry.data.operators.ForcedReplacement.create(draft) });
        const opened = await time(() => CharacterWizard.open());
        app = opened.value;
        numbers.openResume = opened.ms;
        assert.exists(app);
        assert.isBelow(opened.ms, OPEN_BUDGET_MS, "the window should be up before the character is replayed");
        const settled = await time(() => app.settle());
        numbers.replay = settled.ms;
        assert.equal(app.step, "review");
        assert.deepEqual(app.validation.errors, [], "and the replay still finds it complete");
      });
    });
  }, { displayName: "Character Creator: Performance" });
}

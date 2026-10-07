import { MODULE_ID } from "../scripts/main.mjs";
import { DRAFT_FLAG } from "../scripts/contracts.mjs";
import { answerStages } from "./hardcore.mjs";

/*
 * The random character above level 1 (PLAN 8.5/8.6; D35, D36, D39), as a player with a GM online: at level 5 with
 * multiclassing allowed, the dice stop at the multiclass shortlist, then at each subclass and feat shortlist; the
 * player picks, the dice carry on, and the GM's copy holds every pick to the list it was offered.
 */

const flag = () => game.user.getFlag(MODULE_ID, DRAFT_FLAG);
const raw = value => game.user.update({ [`flags.${MODULE_ID}.${DRAFT_FLAG}`]: foundry.data.operators.ForcedReplacement.create(value) });
const wait = ms => new Promise(r => setTimeout(r, ms));

export function registerHardcoreLevelsBatches(quench) {
  quench.registerBatch(`${MODULE_ID}.hardcore-levels@gm`, ({ describe, it, before, after, assert }) => {
    describe("The random character above level 1: shortlists the player picks from", () => {
      let CharacterWizard;
      let saved;
      let app = null;
      const touched = new Set();
      const gm = () => game.users.activeGM;
      const query = (name, data) => gm().query(name, data, { timeout: 120_000 });
      const set = async (key, value) => {
        touched.add(key);
        await query(`${MODULE_ID}.test.setSetting`, { key, value });
        for ( let i = 0; i < 40 && JSON.stringify(game.settings.get(MODULE_ID, key)) !== JSON.stringify(value); i++ ) await wait(100);
      };

      before(async function() {
        this.timeout(300_000);
        assert.isFalse(game.user.isGM, "run as a player");
        assert.exists(gm(), "no active GM — run with npm run test:foundry");
        ({ CharacterWizard } = await import("../scripts/wizard/app.mjs"));
        saved = flag();
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        await query(`${MODULE_ID}.test.submitCleanup`, {});
        await set("characterLimit", 0);
        await set("startingLevel", 5);
        await set("multiclass", true);
        await set("multiclassPrerequisites", false);
        await set("hardcore", { offered: true, free: [], attempts: 1, multiclassChoices: 3, feats: "shortlist", featChoices: 3,
          subclassChoices: 3 });
        app = await CharacterWizard.open();
        await app.settle();
      });
      after(async function() {
        this.timeout(120_000);
        if ( app?.rendered ) await app.close();
        if ( gm() ) {
          await query(`${MODULE_ID}.test.submitCleanup`, {});
          for ( const key of touched ) await query(`${MODULE_ID}.test.setSetting`, { key, reset: true });
        }
        if ( saved === undefined ) await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        else await raw(saved);
      });

      it("the dice stop at the multiclass shortlist first, on the class step", async function() {
        this.timeout(600_000);
        app.element.querySelector('[data-action="roll-character"]').click();
        for ( let i = 0; i < 600 && (app.draft?.mode !== "hardcore"); i++ ) await wait(200);
        await app.settle();
        const stage = app.draft.random.stages.multiclass;
        assert.ok(stage, "a multiclass stage");
        assert.equal(stage.options.length, 3, "three classes offered (prerequisites waived)");
        assert.notInclude(stage.options, app.draft.picks.class, "never the rolled class itself");
        assert.equal(app.step, "review", "the first roll shows what the dice made");
        const go = app.element.querySelector('[data-action="your-turn"]');
        assert.exists(go, "and says what the player has to do next");
        go.click();
        for ( let i = 0; i < 50 && (app.step !== "class"); i++ ) await wait(100);
        await app.settle();
        assert.equal(app.step, "class", "the button takes them to it");
        // No die for anything past level 1 yet (what comes automatically, a grant or a single option, isn't the dice's).
        const at = new Map(app.build.results.map(r => [r.key, r.at ?? 1]));
        const later = app.draft.random.rolls.map(r => r.key.match(/^choice:(.+?@\d+)(?::|$)/)?.[1]).filter(k => k && (at.get(k) > 1));
        assert.deepEqual(later, [], "nothing past level 1 is decided before the split");
        assert.exists(app.element.querySelector(".cc-levels--stage .cc-levels__ask"), "the question is put plainly");
        const rows = [...app.element.querySelectorAll('[data-action="class-level"][data-change="up"]')].map(b => b.dataset.uuid);
        assert.deepEqual(rows.sort(), [...stage.options].sort(), "a row for each class offered, and only those");
        assert.exists(app.element.querySelector('[data-action="class-confirm"]'), "and a way to answer");
      });

      it("taking one of them, then keeping the split: the dice carry on, stopping at each subclass and feat", async function() {
        this.timeout(900_000);
        const offered = app.draft.random.stages.multiclass.options;
        await app.changeClasses("up", offered[0]);
        assert.deepEqual(app.draft.multiclass, [], "on screen until confirmed");
        await app.finishClassStage();
        assert.deepEqual(app.draft.multiclass.map(m => m.uuid), [offered[0]]);
        await app.settle();
        assert.isTrue(app.draft.random.stages.multiclass.answered);
        await answerStages(app);
        const kinds = Object.values(app.draft.random.stages).map(s => s.kind);
        // The SRD has one subclass per class, so a subclass shortlist (D39) only appears with more content.
        console.log(`${MODULE_ID} | hardcore-levels stages: ${kinds.join(", ")}`);
        for ( const [key, s] of Object.entries(app.draft.random.stages) ) {
          if ( s.kind === "multiclass" ) continue;
          assert.isAtMost(s.options.length, 3, key);
          const step = app.draft.recipe.steps.find(x => app.build.results.find(r => r.key === key)?.advancementId === x.advancementId);
          assert.ok(step, `the player answered ${key}`);
        }
        const open = app.build.results.filter(r => r.status === "needsInput" && r.type !== "HitPoints");
        assert.deepEqual(open.map(r => r.title), [], "nothing left open but spells");
      });

      it("the GM's copy creates it, and refuses a pick that wasn't on the list", async function() {
        this.timeout(900_000);
        const { fillSpells } = await import("./wizard.mjs");
        await fillSpells(app);
        await app.goTo("details");
        await app.setDetail("name", "Shortlisted");
        await app.goTo("portrait");
        await app.setPortrait((await import("../scripts/wizard/portrait-step.mjs")).skipPortrait);
        await app.goTo("review");
        await app.settle();
        assert.deepEqual(app.validation.errors, [], JSON.stringify(app.validation.errors).slice(0, 400));

        const { submitDraft } = await import("../scripts/gm/pending.mjs");
        const catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        const subStage = Object.entries(app.draft.random.stages).find(([, s]) => s.kind === "subclass");
        if ( subStage ) {
          const [key, s] = subStage;
          const result = app.build.results.find(r => r.key === key);
          const all = catalog.byCategory.subclass.filter(e => e.system?.classIdentifier
            === app.build.actor.items.get(result.itemId)?.system?.identifier).map(e => e.uuid);
          const outside = all.map(u => u.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.")).find(u => !s.options.includes(u));
          if ( outside ) {
            const tampered = foundry.utils.deepClone(app.draft);
            const step = tampered.recipe.steps.find(x => (x.advancementId === result.advancementId) && (x.level === result.level));
            step.data = { uuid: outside };
            const refused = await submitDraft(tampered, { timeout: 180_000 });
            assert.isFalse(refused.ok, "a subclass the dice didn't offer");
            assert.include(refused.errors.map(e => e.code), "RANDOM_INVALID");
          }
        }
        app.element.querySelector('[data-action="create"]')?.click();
        for ( let i = 0; i < 600 && (app.draft?.status !== "created"); i++ ) await wait(200);
        const keys = app.draft.random.rolls.map(r => r.key);
        assert.equal(app.draft.status, "created", `${JSON.stringify(app.draft.result?.errors ?? []).slice(0, 300)} rolls: ${keys.join(" ")}`.slice(0, 2500));
        const actor = await fromUuid(app.draft.result.actorUuid);
        assert.equal(actor.system.details.level, 5);
        assert.equal(actor.items.filter(i => i.type === "class").length, 2, "two classes");
      });
    });
  });
}

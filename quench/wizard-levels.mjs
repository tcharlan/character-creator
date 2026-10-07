import { MODULE_ID } from "../scripts/main.mjs";
import { DRAFT_FLAG } from "../scripts/contracts.mjs";
import { walkWizard } from "./wizard.mjs";

/*
 * The wizard above level 1 (PLAN 8.4; D32–D37), as a player with a GM online: the GM starts characters at
 * level 5 and allows multiclassing; the player splits the levels between a Cleric and a Wizard on the class
 * step, makes the choices level by level (an ASI can be a feat), chooses spells for each class, and creates the
 * character. Every setting is restored after.
 */

const flag = () => game.user.getFlag(MODULE_ID, DRAFT_FLAG);
const raw = value => game.user.update({ [`flags.${MODULE_ID}.${DRAFT_FLAG}`]: foundry.data.operators.ForcedReplacement.create(value) });

export function registerWizardLevelsBatches(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.wizard-levels@gm`, ({ describe, it, before, after, assert }) => {
    describe("The wizard above level 1, with multiclassing", () => {
      let CharacterWizard;
      let catalog;
      let saved;
      let app = null;
      const touched = new Set();
      const gm = () => game.users.activeGM;
      const query = (name, data) => gm().query(name, data, { timeout: 120_000 });
      const set = async (key, value) => {
        touched.add(key);
        await query(`${MODULE_ID}.test.setSetting`, { key, value });
        for ( let i = 0; i < 40 && JSON.stringify(game.settings.get(MODULE_ID, key)) !== JSON.stringify(value); i++ ) {
          await new Promise(r => setTimeout(r, 100));
        }
      };
      const el = () => app.element;
      const uuid = (category, name) => {
        const e = catalog.byCategory[category].find(x => x.name === name);
        return e.uuid.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.");
      };

      before(async function() {
        this.timeout(300_000);
        assert.isFalse(game.user.isGM, "run as a player");
        assert.exists(gm(), "no active GM — run with npm run test:foundry");
        ({ CharacterWizard } = await import("../scripts/wizard/app.mjs"));
        catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        saved = flag();
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        await query(`${MODULE_ID}.test.submitCleanup`, {});
        await set("characterLimit", 0);
        await set("startingLevel", 5);
        await set("multiclass", true);
        // The walkthrough's standard array leaves a Cleric/Wizard short of 13 in WIS or INT; D35's check has its own test.
        await set("multiclassPrerequisites", false);
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

      it("a new draft starts at the GM's level, and the class step splits it between classes", async function() {
        this.timeout(300_000);
        assert.equal(app.draft.level, 5, "the GM's starting level (D32)");
        await app.goTo("class");
        await app.pick(uuid("class", "Cleric"));
        await app.settle();
        const panel = el().querySelector(".cc-levels");
        assert.exists(panel, "the levels panel");
        assert.include(panel.textContent, "5");
        const wizard = uuid("class", "Wizard");
        const up = () => el().querySelector(`[data-action="class-level"][data-change="up"][data-uuid="${wizard}"]`);
        assert.exists(up(), "every other class is a row with + and −");
        assert.notExists(el().querySelector(`[data-action="class-level"][data-uuid="${uuid("class", "Cleric")}"]`),
          "not the first class, which has what the others leave it");
        assert.notExists(el().querySelector('[data-action="class-confirm"]'), "nothing to confirm yet");
        up().click();
        await app.settle();
        up().click();
        await app.settle();
        assert.deepEqual(app.draft.multiclass, [], "+ and − only change the screen");
        el().querySelector(`[data-action="class-level"][data-change="down"][data-uuid="${wizard}"]`).click();
        await app.settle();
        assert.include(el().querySelector(".cc-levels__confirm").textContent, "Cleric 4 / Wizard 1");
        el().querySelector('[data-action="class-confirm"]').click();
        for ( let i = 0; i < 50 && !app.draft.multiclass.length; i++ ) await new Promise(r => setTimeout(r, 100));
        await app.settle();
        assert.deepEqual(app.draft.multiclass.map(m => m.levels), [1], "confirmed: Cleric 4 / Wizard 1 keeps the ASI");
        assert.equal(app.build.actor.system.details.level, 5);
        const levels = app.build.actor.items.filter(i => i.type === "class").map(c => [c.name, c.system.levels]).sort();
        assert.deepEqual(levels, [["Cleric", 4], ["Wizard", 1]]);
      });

      it("the choices go level by level, and an ASI offers a feat instead (D36)", async function() {
        this.timeout(300_000);
        // The Choices step opens once species and background are picked too.
        const spec = rules() === "legacy" ? { species: "Hill Dwarf", background: "Acolyte" } : { species: "Human", background: "Sage" };
        for ( const role of ["species", "background"] ) {
          await app.goTo(role);
          await app.pick(uuid(role, spec[role]));
        }
        await app.settle();
        await app.goTo("choices");
        await app.settle();
        const headings = [...el().querySelectorAll(".cc-choice-group")].map(h => h.textContent.trim());
        assert.ok(headings.some(h => h.startsWith("Level 4")), `level headings: ${headings.join(" | ")}`);
        const asi = app.build.results.find(r => (r.type === "AbilityScoreImprovement") && (r.at === 4));
        assert.ok(asi, "the Cleric's level-4 ASI");
        await app.openChoice(asi.key);
        // Both on show at once (D36): the scores and the feats, with no switch to find first.
        assert.exists(el().querySelector(".cc-asi-or-feat"), "the increase and the feats side by side");
        assert.exists(el().querySelector('[data-action="asi-raise"]'), "the scores");
        const feat = el().querySelector('[data-action="asi-feat"]');
        assert.exists(feat ?? el().querySelector(".cc-empty"), "the feats on offer");
        if ( feat ) {
          feat.click();
          await app.settle();
          assert.exists(el().querySelector(".cc-asi-option--taken [data-action='asi-feat'][aria-pressed='true']"), "the feat is taken");
          el().querySelector('[data-action="asi-raise"]:not([disabled])').click();
          await app.settle();
          assert.exists(el().querySelector(".cc-asi-option--taken [data-action='asi-raise']"), "+ goes back to the increase");
        }
      });

      it("the rest of the walk: spells for each class, then a review with nothing to fix", async function() {
        this.timeout(900_000);
        await walkWizard(app, { name: `Levels ${rules()}` });
        assert.equal(app.step, "review");
        const broken = app.build.results.filter(r => r.status !== "done" && r.status !== "auto")
          .map(r => ({ item: r.item, title: r.title, at: r.at, status: r.status, data: r.data, max: r.options?.max,
            allowed: r.options?.allowed }));
        assert.deepEqual(app.validation.errors, [], `${JSON.stringify(app.validation.errors).slice(0, 300)} ${JSON.stringify(broken).slice(0, 600)}`);
        assert.ok(Object.keys(app.draft.multiclassSpells).includes("multiclass:wizard"), "the Wizard's own spells");
        // The class tabs and the list tabs stay on screen when another class is opened.
        await app.goTo("spells");
        await app.settle();
        el().querySelector('[data-action="spell-class"][data-root="multiclass:wizard"]').click();
        await app.settle();
        const tabs = [...el().querySelectorAll('.cc-detail [role="tab"]')];
        assert.isAtLeast(tabs.length, 3, "class tabs and list tabs");
        assert.deepEqual(tabs.filter(t => !t.offsetHeight || (t.closest(".cc-methods").getBoundingClientRect().height < t.offsetHeight))
          .map(t => t.textContent.trim()), [], "every tab is visible, its strip not squeezed");
        await app.goTo("review");
        await app.settle();
        assert.include(el().textContent, "Cleric 4 / Wizard 1");
      });

      it("Create gives a level-5 Cleric 4 / Wizard 1 with each class's spells", async function() {
        this.timeout(300_000);
        el().querySelector('[data-action="create"]').click();
        for ( let i = 0; i < 300 && (app.draft?.status !== "created"); i++ ) await new Promise(r => setTimeout(r, 200));
        assert.equal(app.draft.status, "created", JSON.stringify(app.draft.result?.errors ?? []).slice(0, 400));
        const actor = await fromUuid(app.draft.result.actorUuid);
        assert.equal(actor.system.details.level, 5);
        const sources = new Set(actor.items.filter(i => i.type === "spell").map(i => i.system.sourceItem));
        assert.ok(sources.has("class:wizard"), `spells by class: ${[...sources].join(", ")}`);
      });

      it("a Cleric 3 / Wizard 2 walked through the screens (the 2024 Wizard's level-2 Scholar) has nothing to fix", async function() {
        this.timeout(900_000);
        if ( app?.rendered ) await app.close();
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        await query(`${MODULE_ID}.test.submitCleanup`, {});
        app = await CharacterWizard.open();
        await app.settle();
        await app.goTo("class");
        await app.pick(uuid("class", "Cleric"));
        await app.settle();
        await app.changeClasses("up", uuid("class", "Wizard"));
        await app.changeClasses("up", uuid("class", "Wizard"));
        await app.confirmClasses();
        await walkWizard(app, { name: `Scholar ${rules()}` });
        const broken = app.build.results.filter(r => r.status !== "done" && r.status !== "auto")
          .map(r => ({ item: r.item, title: r.title, at: r.at, status: r.status, data: r.data, max: r.options?.max,
            allowed: r.options?.allowed }));
        assert.deepEqual(app.validation.errors, [], `${JSON.stringify(app.validation.errors).slice(0, 300)} ${JSON.stringify(broken).slice(0, 800)}`);
      });
    });
  });
}

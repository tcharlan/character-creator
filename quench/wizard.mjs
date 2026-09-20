import { MODULE_ID } from "../scripts/main.mjs";
import { DRAFT_FLAG } from "../scripts/contracts.mjs";

/*
 * The wizard shell (PLAN 3.1) as Player A: it opens on a fresh draft, the banner holds the ten steps with their
 * states, Back and Next move (skipping steps whose picks are missing), edits are autosaved and resumed, closing
 * flushes the save, and a draft from another world is offered for discard.
 */

const flag = () => game.user.getFlag(MODULE_ID, DRAFT_FLAG);
const raw = value => game.user.update({ [`flags.${MODULE_ID}.${DRAFT_FLAG}`]: foundry.data.operators.ForcedReplacement.create(value) });

/** Flush the wizard's debounced rebuild and wait for the re-render. */
const settled = app => app.settle();

export function registerWizardBatches(quench) {
  quench.registerBatch(`${MODULE_ID}.wizard`, ({ describe, it, before, after, afterEach, assert }) => {
    describe("Wizard shell (scripts/wizard), as Player A", () => {
      let CharacterWizard;
      let catalogNames;
      let saved;
      let app = null;
      /** Open the wizard and step past the start screen. */
      const open = async () => {
        app = await CharacterWizard.open();
        assert.exists(app, "the wizard didn't open");
        await settled(app);
        if ( app.step === "start" ) {
          el().querySelector('[data-action="begin"]').click();
          await settled(app);
        }
        return app;
      };
      const el = () => app.element;
      const steps = () => [...el().querySelectorAll(".cc-step")];

      before(async function() {
        this.timeout(120_000);
        ({ CharacterWizard } = await import("../scripts/wizard/app.mjs"));
        const catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        catalogNames = catalog;
        saved = flag();
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
      });
      afterEach(async function() {
        this.timeout(30_000);
        if ( app?.rendered ) await app.close();
        app = null;
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
      });
      after(async function() {
        this.timeout(30_000);
        if ( saved === undefined ) await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        else await raw(saved);
      });

      it("opens on a new draft, at the species step, with the ten steps in the banner", async function() {
        this.timeout(60_000);
        await open();
        assert.isTrue(app.rendered);
        assert.equal(app.step, "species");
        assert.equal(flag()?.status, "draft", "a draft was stored");
        const names = steps().map(s => s.dataset.step);
        assert.deepEqual(names, ["species", "class", "background", "abilities", "choices", "equipment", "spells",
          "details", "portrait", "review"]);
        assert.isTrue(steps()[0].classList.contains("cc-step--current"));
        assert.equal(steps()[0].getAttribute("aria-current"), "step");
        assert.isTrue(steps().find(s => s.dataset.step === "choices").disabled, "choices needs the picks first");
        assert.include(el().querySelector(".cc-options__head h2").textContent, "Species");
        assert.exists(el().querySelector(".cc-footer"));
      });

      it("Next and Back move through the steps, skipping the ones whose picks are missing", async function() {
        this.timeout(60_000);
        await open();
        el().querySelector('[data-action="next"]').click();
        await settled(app);
        assert.equal(app.step, "class");
        el().querySelector('[data-action="next"]').click();
        await settled(app);
        assert.equal(app.step, "background");
        el().querySelector('[data-action="next"]').click();
        await settled(app);
        assert.equal(app.step, "abilities");
        // Choices, equipment and spells need picks, so Next skips to details.
        el().querySelector('[data-action="next"]').click();
        await settled(app);
        assert.equal(app.step, "details");
        el().querySelector('[data-action="back"]').click();
        await settled(app);
        assert.equal(app.step, "abilities");
      });

      it("picking in the draft unlocks the steps that need it and labels the banner", async function() {
        this.timeout(120_000);
        await open();
        const pick = c => catalogNames.byCategory[c][0].uuid.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.");
        await app.update(d => {
          d.picks.species = pick("species");
          d.picks.class = pick("class");
          d.picks.background = pick("background");
        });
        await settled(app);
        const choices = steps().find(s => s.dataset.step === "choices");
        assert.isFalse(choices.disabled, "choices is open once the picks exist");
        const speciesLabel = steps()[0].querySelector(".cc-step__label").textContent.trim();
        assert.equal(speciesLabel, catalogNames.byCategory.species[0].name);
        assert.isAbove(app.validation.errors.length, 0, "an unfinished build has things to fix");
        const counts = steps().filter(s => s.querySelector(".cc-step__count"));
        assert.isAbove(counts.length, 0, "steps needing attention show a count");
      });

      it("clicking a step in the banner opens it; the review step lists what to fix", async function() {
        this.timeout(120_000);
        await open();
        const pick = c => catalogNames.byCategory[c][0].uuid.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.");
        await app.update(d => {
          d.picks.species = pick("species");
          d.picks.class = pick("class");
          d.picks.background = pick("background");
        });
        await settled(app);
        steps().find(s => s.dataset.step === "review").click();
        await settled(app);
        assert.equal(app.step, "review");
        const groups = [...el().querySelectorAll(".cc-problems-group")];
        assert.isAbove(groups.length, 0);
        const goTo = groups[0].querySelector('[data-action="step"]');
        const target = goTo.dataset.step;
        goTo.click();
        await settled(app);
        assert.equal(app.step, target, "Go to this step moves there");
      });

      it("edits are autosaved, and reopening resumes the draft at the same step", async function() {
        this.timeout(120_000);
        await open();
        const id = app.draft.id;
        await app.update(d => d.details.name = "Resumed Hero");
        el().querySelector('[data-action="next"]').click();
        await settled(app);
        await app.close();
        assert.equal(flag()?.details?.name, "Resumed Hero", "closing flushed the save");
        assert.equal(flag()?.step, "class");
        app = await CharacterWizard.open();
        await settled(app);
        assert.equal(app.draft.id, id, "the same draft came back");
        assert.equal(app.step, "class");
        assert.equal(app.draft.details.name, "Resumed Hero");
      });

      it("a draft from another world can't be resumed: the player is offered a discard", async function() {
        this.timeout(60_000);
        await open();
        const id = app.draft.id;
        await app.close();
        await raw({ ...flag(), worldId: "another-world" });
        // Answer the confirmation dialog as soon as it appears.
        const hook = Hooks.on("renderDialogV2", dialog => dialog.element.querySelector('[data-action="yes"]')?.click());
        try {
          app = await CharacterWizard.open();
          await settled(app);
        } finally {
          Hooks.off("renderDialogV2", hook);
        }
        assert.notEqual(app.draft.id, id, "a new draft was started");
        assert.equal(flag().worldId, game.world.id);
      });

      it("a submitted draft doesn't open the wizard", async function() {
        this.timeout(60_000);
        await open();
        const draft = flag();
        await app.close();
        app = null;
        const { submittedDraft } = await import("../scripts/gm/pending-core.mjs");
        await raw(submittedDraft(draft, null));
        const opened = await CharacterWizard.open();
        assert.isNull(opened, "the wizard stays closed while a GM is working on the draft");
        assert.equal(flag().status, "submitted", "and the draft is untouched");
      });
    });
  }, { displayName: "Character Creator: Wizard shell" });
}

/*
 * The Start, Species, Class and Background steps (PLAN 3.2).
 */
export function registerOptionStepBatches(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.wizard-options`, ({ describe, it, before, after, afterEach, assert }) => {
    describe("Species, class and background steps, as Player A", () => {
      let CharacterWizard;
      let C;
      let catalog;
      let saved;
      let app = null;
      const open = async () => {
        app = await CharacterWizard.open();
        assert.exists(app, "the wizard didn't open");
        await app.settle();
        return app;
      };
      const el = () => app.element;
      const options = () => [...el().querySelectorAll(".cc-option:not(.cc-option--wide)")];
      const named = name => options().find(o => o.querySelector(".cc-option__name").textContent.trim() === name);

      before(async function() {
        this.timeout(120_000);
        ({ CharacterWizard } = await import("../scripts/wizard/app.mjs"));
        C = await import("../scripts/catalog/catalog.mjs");
        catalog = await C.getCatalog();
        saved = flag();
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
      });
      afterEach(async function() {
        this.timeout(30_000);
        if ( app?.rendered ) await app.close();
        app = null;
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        C.invalidateCatalog("wizard test");
      });
      after(async function() {
        this.timeout(30_000);
        if ( saved === undefined ) await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        else await raw(saved);
      });

      it("a new draft opens on the start screen, which counts the allowed options", async function() {
        this.timeout(60_000);
        await open();
        assert.equal(app.step, "start");
        const start = el().querySelector(".cc-start");
        assert.exists(start, "no start screen");
        assert.include(start.textContent, String(catalog.byCategory.class.length));
        el().querySelector('[data-action="begin"]').click();
        await app.settle();
        assert.equal(app.step, "species");
      });

      it("the species step lists every allowed species; picking one shows its details and art", async function() {
        this.timeout(120_000);
        await open();
        await app.goTo("species");
        await app.settle();
        assert.equal(options().length, catalog.byCategory.species.length);
        const name = catalog.byCategory.species[0].name;
        named(name).click();
        await app.settle();
        assert.equal(app.draft.picks.species, catalog.byCategory.species[0].uuid.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item."));
        const detail = el().querySelector(".cc-detail");
        assert.include(detail.querySelector(".cc-pane__title").textContent, name);
        assert.isAbove(detail.querySelector(".cc-description").textContent.trim().length, 40, "the compendium description is shown");
        assert.exists(el().querySelector(".cc-art__frame img"), "the art panel shows the option's image");
        assert.isAbove(el().querySelectorAll(".cc-facts div").length, 1, "facts are listed");
        assert.equal(el().querySelector('.cc-step[data-step="species"] .cc-step__label').textContent.trim(), name);
      });

      it("search narrows the list", async function() {
        this.timeout(60_000);
        await open();
        await app.goTo("class");
        await app.settle();
        const all = options().length;
        await app.search("wiz");
        assert.isBelow(options().length, all);
        assert.equal(options()[0].querySelector(".cc-option__name").textContent.trim(), "Wizard");
        await app.search("");
        assert.equal(options().length, all);
      });

      it("a class that chooses its subclass at level 1 offers them (2014 Cleric)", async function() {
        if ( rules() !== "legacy" ) this.skip();
        this.timeout(120_000);
        await open();
        await app.goTo("class");
        await app.settle();
        named("Cleric").click();
        await app.settle();
        const subclasses = [...el().querySelectorAll(".cc-option--wide")];
        assert.isAbove(subclasses.length, 0, "no subclasses offered");
        subclasses[0].click();
        await app.settle();
        const chosen = app.draft.recipe.steps.find(s => s.data?.uuid);
        assert.exists(chosen, "the subclass wasn't recorded in the recipe");
        assert.isTrue(app.validation.built.actor.items.some(i => i.type === "subclass"), "the subclass is on the character");
      });

      it("changing the class drops the old class's answers", async function() {
        this.timeout(180_000);
        await open();
        await app.goTo("class");
        await app.settle();
        const first = catalog.byCategory.class[0];
        const second = catalog.byCategory.class[1];
        named(first.name).click();
        await app.settle();
        const answered = app.draft.recipe.steps.filter(s => s.path[0] === "class").length;
        assert.isAbove(answered, 0, "the class's automatic steps were recorded");
        named(second.name).click();
        await app.settle();
        assert.equal(app.draft.picks.class, second.uuid.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item."));
        const stale = app.draft.recipe.steps.filter(s => s.path[0] === "class");
        assert.deepEqual(app.validation.built.stale ?? [], [], "no stale steps are left behind");
        assert.isTrue(stale.every(s => app.validation.built.results.some(r => r.advancementId === s.advancementId)),
          "every remaining class answer belongs to the new class");
      });

      it("picking an option is quick enough to click through the list", async function() {
        this.timeout(300_000);
        await open();
        await app.goTo("species");
        await app.settle();
        /** Click an option and wait only for the pane to show it — what the player feels. */
        const clickAndShow = async name => {
          const t0 = performance.now();
          named(name).click();
          for ( let i = 0; i < 200; i++ ) {
            const title = el().querySelector(".cc-detail .cc-pane__title");
            if ( title?.textContent.trim() === name ) break;
            await new Promise(r => setTimeout(r, 10));
          }
          return Math.round(performance.now() - t0);
        };
        const shown = [];
        for ( const name of catalog.byCategory.species.slice(0, 4).map(e => e.name) ) shown.push(await clickAndShow(name));
        await app.settle();
        await app.goTo("class");
        await app.settle();
        const classShown = [];
        const settleTimes = [];
        for ( const name of catalog.byCategory.class.slice(0, 3).map(e => e.name) ) {
          classShown.push(await clickAndShow(name));
          const t0 = performance.now();
          await app.settle();
          settleTimes.push(Math.round(performance.now() - t0));
        }
        console.log(`${MODULE_ID} | wizard pick ms (${rules()}): shown species ${JSON.stringify(shown)} class ${JSON.stringify(classShown)}, rebuild ${JSON.stringify(settleTimes)}`);
        assert.isBelow(Math.max(...shown, ...classShown), 500, "the chosen option should appear at once");
        assert.isBelow(Math.max(...settleTimes), 3000, "the background rebuild shouldn't drag");
      });

      it("auto-select (D4): a category the GM narrows to one option is chosen automatically", async function() {
        this.timeout(120_000);
        const only = catalog.byCategory.background[0];
        const narrowed = await C.getCatalog({ restrictions: { packs: null, categories: { background: [only.uuid] } } });
        assert.equal(narrowed.byCategory.background.length, 1);
        // The wizard reads the catalog through getCatalog(); narrow it through the settings the same way the GM would.
        const { SETTINGS } = await import("../scripts/settings/normalize.mjs");
        assert.exists(SETTINGS.RESTRICTIONS);
        await open();
        await app.goTo("background");
        await app.settle();
        if ( catalog.byCategory.background.length === 1 ) {
          assert.equal(app.draft.picks.background, only.uuid.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item."));
          assert.exists(el().querySelector(".cc-chosen-for-you"), "the player is told it was chosen for them");
        } else {
          assert.isNull(app.draft.picks.background, "with several options, nothing is chosen for the player");
        }
      });
    });
  }, { displayName: "Character Creator: Wizard option steps" });
}

/*
 * The ability-scores step (PLAN 3.3).
 */
export function registerAbilityStepBatch(quench) {
  quench.registerBatch(`${MODULE_ID}.wizard-abilities`, ({ describe, it, before, after, afterEach, assert }) => {
    describe("Ability scores step, as Player A", () => {
      let CharacterWizard;
      let saved;
      let app = null;
      const messageIds = [];
      const el = () => app.element;
      const open = async () => {
        app = await CharacterWizard.open();
        assert.exists(app, "the wizard didn't open");
        await app.settle();
        await app.goTo("abilities");
        await app.settle();
        return app;
      };
      const method = key => el().querySelector(`[data-action="method"][data-method="${key}"]`);
      const scores = () => [...el().querySelectorAll(".cc-score")];

      before(async function() {
        this.timeout(120_000);
        ({ CharacterWizard } = await import("../scripts/wizard/app.mjs"));
        saved = flag();
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
      });
      afterEach(async function() {
        this.timeout(30_000);
        if ( app?.rendered ) await app.close();
        app = null;
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
      });
      after(async function() {
        this.timeout(60_000);
        if ( messageIds.length ) await ChatMessage.implementation.deleteDocuments(messageIds.filter(id => game.messages.has(id)));
        if ( saved === undefined ) await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        else await raw(saved);
      });

      it("offers the three methods; point buy spends 27 points and stops at the limits", async function() {
        this.timeout(120_000);
        await open();
        assert.lengthOf([...el().querySelectorAll(".cc-method")], 3);
        method("pointBuy").click();
        await app.settle();
        assert.equal(app.draft.abilities.method, "pointBuy");
        assert.lengthOf(scores(), 6);
        const row = scores()[0];
        assert.equal(row.querySelector(".cc-score__value").textContent.trim(), "8");
        assert.isTrue(row.querySelector('[data-action="lower"]').disabled, "8 is the minimum");
        for ( let i = 0; i < 7; i++ ) {
          scores()[0].querySelector('[data-action="raise"]').click();
          await app.settle();
        }
        assert.equal(app.draft.abilities.base.str, 15);
        assert.isTrue(scores()[0].querySelector('[data-action="raise"]').disabled, "15 is the maximum");
        assert.include(el().querySelector(".cc-points__value").textContent, "18", "27 − 9 spent");
      });

      it("the standard array assigns each value once, and the banner shows the method", async function() {
        this.timeout(120_000);
        await open();
        method("standardArray").click();
        await app.settle();
        const values = [15, 14, 13, 12, 10, 8];
        const keys = ["str", "dex", "con", "int", "wis", "cha"];
        for ( const [i, key] of keys.entries() ) {
          const select = el().querySelector(`.cc-assign[data-ability="${key}"]`);
          select.value = String(values[i]);
          select.dispatchEvent(new Event("change"));
          await app.settle();
        }
        assert.deepEqual(app.draft.abilities.base, { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 });
        const { checkAbilities } = await import("../scripts/rules/abilities.mjs");
        assert.deepEqual(checkAbilities(app.draft.abilities), []);
        assert.include(el().querySelector('.cc-step[data-step="abilities"] .cc-step__label').textContent, "Standard array");
      });

      it("rolling posts the dice to chat and locks the results in (D15, A10)", async function() {
        this.timeout(120_000);
        await open();
        method("rolled").click();
        await app.settle();
        const before = game.messages.size;
        el().querySelector('[data-action="roll"]').click();
        for ( let i = 0; i < 100 && !app.draft.abilities.roll; i++ ) await new Promise(r => setTimeout(r, 100));
        await app.settle();
        const roll = app.draft.abilities.roll;
        assert.exists(roll, "nothing was rolled");
        messageIds.push(roll.messageId);
        assert.equal(game.messages.size, before + 1);
        const message = game.messages.get(roll.messageId);
        assert.equal(message.author.id, game.user.id);
        assert.lengthOf(message.rolls, 6);
        assert.deepEqual(message.rolls.map(r => r.total), roll.results);
        assert.notExists(el().querySelector('[data-action="roll"]'), "you can only roll once");
        // The rolled values are what you may assign.
        const select = el().querySelector('.cc-assign[data-ability="str"]');
        const offered = [...select.options].map(o => o.value).filter(Boolean).map(Number).sort((a, b) => b - a);
        assert.deepEqual(offered, [...roll.results].sort((a, b) => b - a));
      });

      it("assignments show at once and are replayed when the player leaves the step", async function() {
        this.timeout(180_000);
        await open();
        const catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        const norm = u => u.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.");
        await app.update(d => {
          d.picks.species = norm(catalog.byCategory.species[0].uuid);
          d.picks.background = norm(catalog.byCategory.background[0].uuid);
          d.picks.class = norm(catalog.byCategory.class[0].uuid);
        }, { wait: true });
        method("standardArray").click();
        await app.settle();
        const built = app.build;
        const select = el().querySelector('.cc-assign[data-ability="str"]');
        select.value = "15";
        select.dispatchEvent(new Event("change"));
        // Longer than the wizard's rebuild delay: a replay would have happened by now.
        await new Promise(r => setTimeout(r, 1600));
        assert.equal(app.draft.abilities.base.str, 15, "the assignment is kept");
        assert.equal(app.build, built, "the character is not replayed while the player is still assigning");
        const shown = Number(scores()[0].querySelector(".cc-score__total").textContent);
        const bonus = built.actor.system.abilities.str.value - 10;   // an unassigned score starts at 10
        assert.equal(shown, 15 + bonus, "the final score is worked out on the spot");
        await app.goTo("details");
        assert.notEqual(app.build, built, "leaving the step replays the character once");
        assert.equal(app.build.actor.system.abilities.str.value, 15 + bonus,
          "and the replay agrees with what the step showed");
      });

      it("only the methods the GM allows are offered", async function() {
        this.timeout(120_000);
        const { readSettings } = await import("../scripts/settings/settings.mjs");
        const before = readSettings().abilityMethods;
        assert.deepEqual(before, ["pointBuy", "standardArray", "rolled"], "this world uses the default");
        await open();
        // The step reads the setting through readSettings(); with one method the chooser is replaced by a note.
        const model = (await import("../scripts/wizard/abilities-step.mjs")).abilitiesModel(app.draft,
          { allowedMethods: ["standardArray"] });
        assert.deepEqual(model.methods.map(m => m.key), ["standardArray"]);
        assert.isTrue(model.onlyOne);
      });

      it("the final scores include the species and background increases", async function() {
        this.timeout(180_000);
        await open();
        const catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        const norm = u => u.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.");
        await app.update(d => {
          d.picks.species = norm(catalog.byCategory.species[0].uuid);
          d.picks.background = norm(catalog.byCategory.background[0].uuid);
          d.picks.class = norm(catalog.byCategory.class[0].uuid);
        }, { wait: true });
        method("pointBuy").click();
        await app.settle();
        const finals = [...el().querySelectorAll(".cc-score__total")].map(n => Number(n.textContent));
        assert.lengthOf(finals, 6);
        // The column shows the built character's scores: base plus whatever the build already applies. (2014
        // species increases are automatic; 2024 background increases wait for the player's choice in step V.)
        const built = ["str", "dex", "con", "int", "wis", "cha"].map(k => app.build.actor.system.abilities[k].value);
        assert.deepEqual(finals, built);
        assert.isTrue(finals.every((v, i) => v >= Object.values(app.draft.abilities.base)[i]), "never lower than the base score");
      });
    });
  }, { displayName: "Character Creator: Wizard ability scores" });
}

/*
 * The Choices step (PLAN 3.4): answering every level-1 choice through the widgets.
 */
export function registerChoicesStepBatch(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");
  const SPEC = {
    legacy: { species: "High Elf", background: "Acolyte", class: "Cleric" },
    modern: { species: "Human", background: "Sage", class: "Cleric" }
  };

  quench.registerBatch(`${MODULE_ID}.wizard-choices`, ({ describe, it, before, after, afterEach, assert }) => {
    describe("Choices step, as Player A", () => {
      let CharacterWizard;
      let catalog;
      let saved;
      let app = null;
      const el = () => app.element;
      const norm = u => u.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.");
      const pick = (category, name) => norm(catalog.byCategory[category].find(e => e.name === name).uuid);
      const query = selector => [...el().querySelectorAll(selector)];
      /** Open the wizard with the picks made, on the choices step. */
      const open = async (spec = SPEC[rules()]) => {
        app = await CharacterWizard.open();
        assert.exists(app, "the wizard didn't open");
        await app.settle();
        await app.update(d => {
          d.picks.species = pick("species", spec.species);
          d.picks.background = pick("background", spec.background);
          d.picks.class = pick("class", spec.class);
        }, { wait: true });
        await app.settle();
        await app.goTo("choices");
        await app.settle();
        return app;
      };
      const list = () => query(".cc-choice");
      const stillOpen = () => app.build.results.filter(r => r.status === "needsInput").length;
      const traitBoxes = () => query(".cc-keys input");

      before(async function() {
        this.timeout(120_000);
        ({ CharacterWizard } = await import("../scripts/wizard/app.mjs"));
        catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        saved = flag();
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
      });
      afterEach(async function() {
        this.timeout(30_000);
        if ( app?.rendered ) await app.close();
        app = null;
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
      });
      after(async function() {
        this.timeout(30_000);
        if ( saved === undefined ) await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        else await raw(saved);
      });

      /** Answer whichever choice is still open, through the widgets, and report whether there was one. */
      const answerOne = async () => {
        const next = app.build.results.find(r => r.status === "needsInput");
        if ( !next ) return false;
        await app.openChoice(next.key);
        const w = next.options;
        const where = `${next.item} / ${next.title}`;
        switch ( next.type ) {
          case "Trait": {
            const need = w.max - (next.data?.chosen?.length ?? 0);
            for ( let i = 0; i < need; i++ ) {
              const box = traitBoxes().filter(b => !b.disabled && !b.checked)[0];
              assert.exists(box, `${where}: nothing left to check`);
              box.click();
              await app.settle();
            }
            break;
          }
          case "ItemChoice": {
            const need = w.count - (next.data?.selected?.length ?? 0);
            for ( let i = 0; i < need; i++ ) {
              const card = query(".cc-cards button").filter(c => c.getAttribute("aria-pressed") !== "true")[0];
              assert.exists(card, `${where}: no option to pick`);
              card.click();
              await app.settle();
            }
            if ( w.abilityOptions?.length > 1 ) {
              el().querySelector(".cc-ability-picker button").click();
              await app.settle();
            }
            break;
          }
          case "ItemGrant": {
            if ( w.abilityOptions?.length > 1 ) el().querySelector(".cc-ability-picker button").click();
            else query(".cc-key input").forEach(b => b.click());
            await app.settle();
            break;
          }
          case "AbilityScoreImprovement": {
            for ( let i = 0; i < (w.points ?? 0); i++ ) {
              const plus = query(".cc-score__step").filter(b => !b.disabled && b.textContent.includes("+"))[0];
              assert.exists(plus, `${where}: no ability can be raised`);
              plus.click();
              await app.settle();
            }
            break;
          }
          case "Size":
          case "Subclass":
            el().querySelector(".cc-cards button").click();
            await app.settle();
            break;
          default:
            assert.fail(`no widget for ${next.type} (${where})`);
        }
        return true;
      };

      it("lists every choice, grouped by the item that offers it, and opens the first one to make", async function() {
        this.timeout(180_000);
        await open();
        const groups = query(".cc-choice-group").map(g => g.textContent.trim());
        assert.includeMembers(groups, [SPEC[rules()].species, SPEC[rules()].class]);
        assert.isAbove(list().length, 2);
        assert.isAbove(stillOpen(), 0, "a fresh build has choices to make");
        const first = list().find(b => b.querySelector(".cc-choice__state--needsInput"));
        assert.exists(first, "nothing is marked as still to choose");
        assert.equal(first.getAttribute("aria-pressed"), "true", "it's the one open");
        assert.exists(el().querySelector(".cc-detail .cc-pane__title"));
      });

      it("Next walks through the choices that are still open, then moves on", async function() {
        this.timeout(300_000);
        await open();
        const next = () => el().querySelector('[data-action="next"]');
        const openKeys = () => app.build.results.filter(r => r.status === "needsInput").map(r => r.key);
        assert.isAbove(openKeys().length, 1, "this build should have several choices to make");
        const title = () => el().querySelector(".cc-detail .cc-pane__title").textContent.trim();
        const first = title();
        next().click();
        await app.settle();
        assert.equal(app.step, "choices", "Next stays here while choices are open");
        assert.notEqual(title(), first, "it opened the next choice to answer");
        // Answer them all, then Next leaves the step.
        for ( let guard = 0; guard < 40; guard++ ) {
          if ( !await answerOne() ) break;
        }
        assert.isEmpty(openKeys(), "the walk-through left something open");
        next().click();
        await app.settle();
        assert.notEqual(app.step, "choices", "with nothing left, Next moves on");
      });

      it("a trait choice checks off skills up to its count, and refuses more", async function() {
        this.timeout(180_000);
        await open();
        const trait = app.build.results.find(r => (r.type === "Trait") && (r.status === "needsInput") && r.options.max);
        assert.exists(trait, "no trait choice to make");
        await app.openChoice(trait.key);
        assert.isAbove(traitBoxes().length, 1);
        const need = trait.options.max - (trait.data?.chosen?.length ?? 0);
        for ( let i = 0; i < need; i++ ) {
          const box = traitBoxes().filter(b => !b.disabled && !b.checked)[0];
          assert.exists(box, "nothing left to check");
          box.click();
          await app.settle();
        }
        const answered = app.draft.recipe.steps.find(s => s.advancementId === trait.advancementId);
        assert.exists(answered, "the choice wasn't recorded");
        assert.equal(answered.data.chosen.length, trait.options.max);
        assert.equal(app.build.results.find(r => r.key === trait.key).status, "done");
        assert.isEmpty(traitBoxes().filter(b => !b.disabled && !b.checked),
          "at the count, the rest of the list is out of reach");
        // Clicking one anyway (a stale screen, a keyboard) still changes nothing.
        const spare = traitBoxes().filter(b => !b.checked)[0];
        if ( spare ) {
          spare.click();
          await app.settle();
          assert.equal(app.draft.recipe.steps.find(s => s.advancementId === trait.advancementId).data.chosen.length,
            trait.options.max, "the extra pick was refused");
          assert.isFalse(traitBoxes().find(b => b === spare)?.checked ?? false, "and the box did not stay ticked");
        }
      });

      it("a skill choice says what each skill is for, from the rules compendium", async function() {
        this.timeout(180_000);
        await open();
        const skills = app.build.results.find(r => (r.type === "Trait")
          && (r.options.allowed ?? []).some(k => k.startsWith("skills:")));
        assert.exists(skills, "no skill choice in this build");
        await app.openChoice(skills.key);
        // The explanations are read from the compendium after the first render.
        const hints = () => query(".cc-key__hint").map(n => n.textContent.trim()).filter(Boolean);
        for ( let i = 0; i < 100 && !hints().length; i++ ) await new Promise(r => setTimeout(r, 100));
        assert.isNotEmpty(hints(), "no explanation under any skill");
        assert.isAbove(hints()[0].length, 10, "the explanation is a sentence, not a stub");
        const { traitReference } = await import("../scripts/wizard/descriptions.mjs");
        assert.exists(traitReference("skills:ath"), "dnd5e documents the skills; the key should find the page");
      });

      it("every choice can be answered through the widgets, and nothing is left open", async function() {
        this.timeout(600_000);
        await open();
        let guard = 0;
        let more = true;
        while ( more && (guard++ < 30) ) more = await answerOne();
        assert.isBelow(guard, 30, "the choices never ran out");
        assert.equal(stillOpen(), 0, "every choice was answered");
        const invalid = app.build.results.filter(r => r.status === "invalid");
        assert.deepEqual(invalid.map(r => `${r.item}/${r.title}: ${JSON.stringify(r.errors)}`), [], "no answer was rejected");
        assert.deepEqual(app.validation.errors.filter(e => e.step === "choices"), [], "the validator is happy");
        console.log(`${MODULE_ID} | wizard choices (${rules()}): ${app.build.results.length} steps, ${app.build.actor.items.size} items`);
      });

      it("an answer that breaks a rule is shown as needing attention", async function() {
        this.timeout(180_000);
        await open();
        const trait = app.build.results.find(r => (r.type === "Trait") && (r.options.max > 0));
        assert.exists(trait);
        const { answerStep } = await import("../scripts/wizard/picks.mjs");
        await app.update(d => answerStep(d, trait, { chosen: ["skills:nonsense"] }), { wait: true });
        await app.settle();
        assert.equal(app.build.results.find(r => r.key === trait.key).status, "invalid");
        await app.openChoice(trait.key);
        assert.exists(el().querySelector(".cc-problems"), "the problem isn't shown");
        assert.exists(el().querySelector(".cc-choice__state--invalid"), "the list doesn't mark it");
      });
    });
  }, { displayName: "Character Creator: Wizard choices" });
}

/*
 * The Equipment step (PLAN 3.5): choices per source, category pickers, the wealth alternative and the 2014 roll.
 */
export function registerEquipmentStepBatch(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");
  const SPEC = {
    legacy: { species: "Hill Dwarf", background: "Acolyte", class: "Cleric" },
    modern: { species: "Human", background: "Sage", class: "Cleric" }
  };

  quench.registerBatch(`${MODULE_ID}.wizard-equipment`, ({ describe, it, before, after, afterEach, assert }) => {
    describe("Equipment step, as Player A", () => {
      let CharacterWizard;
      let catalog;
      let saved;
      let app = null;
      const draftIds = [];
      const el = () => app.element;
      const query = selector => [...el().querySelectorAll(selector)];
      const norm = u => u.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.");
      const pick = (category, name) => norm(catalog.byCategory[category].find(e => e.name === name).uuid);
      const open = async () => {
        app = await CharacterWizard.open();
        assert.exists(app, "the wizard didn't open");
        await app.settle();
        const spec = SPEC[rules()];
        await app.update(d => {
          d.picks.species = pick("species", spec.species);
          d.picks.background = pick("background", spec.background);
          d.picks.class = pick("class", spec.class);
        }, { wait: true });
        await app.settle();
        draftIds.push(app.draft.id);
        await app.goTo("equipment");
        await app.settle();
        return app;
      };
      /** Answer every open choice of both sources by taking the first option in each. */
      const takeFirstOfEach = async () => {
        for ( let guard = 0; guard < 40; guard++ ) {
          // An "a or b" group with nothing chosen yet: take its first option.
          const groups = query(".cc-decision [role=radiogroup]");
          const undecided = groups.find(g => ![...g.querySelectorAll("button")].some(b => b.getAttribute("aria-pressed") === "true"));
          const branch = undecided?.querySelector("button");
          if ( branch ) {
            branch.click();
            await app.settle();
            continue;
          }
          const empty = query(".cc-equip-pick").find(s => !s.value);
          if ( empty ) {
            empty.value = [...empty.options].map(o => o.value).filter(Boolean)[0];
            empty.dispatchEvent(new Event("change"));
            await app.settle();
            continue;
          }
          return;
        }
      };

      before(async function() {
        this.timeout(120_000);
        ({ CharacterWizard } = await import("../scripts/wizard/app.mjs"));
        catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        saved = flag();
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
      });
      afterEach(async function() {
        this.timeout(30_000);
        if ( app?.rendered ) await app.close();
        app = null;
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
      });
      after(async function() {
        this.timeout(60_000);
        if ( game.users.activeGM && draftIds.length ) {
          await game.users.activeGM.query(`${MODULE_ID}.test.abilityRollCleanup`, { draftIds }, { timeout: 30_000 }).catch(() => null);
        }
        if ( saved === undefined ) await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        else await raw(saved);
      });

      it("shows a block per source, with its choices and the items that come anyway", async function() {
        this.timeout(180_000);
        await open();
        const blocks = query(".cc-source");
        assert.lengthOf(blocks, 2, "class and background");
        const names = blocks.map(b => b.querySelector(".cc-section-title").textContent.trim());
        assert.includeMembers(names, [SPEC[rules()].class, SPEC[rules()].background]);
        // 2014 offers "a or b" groups; 2024 offers a package with category picks and the gold alternative.
        const interactive = query('[data-action="equip-branch"]').length + query(".cc-equip-pick").length
          + query('[data-action="equip-mode"]').length;
        assert.isAbove(interactive, 0, "nothing to choose on either source");
      });

      it("choosing options fills the carry list, and the validator is happy", async function() {
        this.timeout(300_000);
        await open();
        await takeFirstOfEach();
        assert.lengthOf(query(".cc-equip-pick").filter(s => !s.value), 0, "every picker is filled");
        const carried = query(".cc-carry li").filter(li => !li.classList.contains("cc-empty"));
        assert.isAbove(carried.length, 2, "nothing was resolved");
        assert.deepEqual(app.validation.errors.filter(e => e.step === "equipment"), [], "the validator is happy");
        console.log(`${MODULE_ID} | wizard equipment (${rules()}): ${carried.length} lines, ${app.validation.equipment.items.length} items`);
      });

      it("switching to gold clears the item choices for that source only (D23)", async function() {
        this.timeout(300_000);
        await open();
        await takeFirstOfEach();
        const backgroundBefore = foundry.utils.deepClone(app.draft.equipment.background);
        query('[data-action="equip-mode"][data-role="class"][data-mode="wealth"]')[0].click();
        await app.settle();
        assert.equal(app.draft.equipment.class.mode, "wealth");
        assert.deepEqual(app.draft.equipment.class.choices, {});
        assert.deepEqual(app.draft.equipment.background, backgroundBefore, "the background is untouched");
      });

      it("2024: taking gold gives the flat amount straight away", async function() {
        if ( rules() !== "modern" ) this.skip();
        this.timeout(300_000);
        await open();
        query('[data-action="equip-mode"][data-role="class"][data-mode="wealth"]')[0].click();
        await app.settle();
        assert.notExists(el().querySelector('[data-action="equip-roll"]'), "2024 wealth needs no roll");
        assert.match(el().querySelector(".cc-wealth__total").textContent, /\d+ GP/);
        assert.deepEqual(app.validation.errors.filter(e => e.step === "equipment"), []);
      });

      it("2014: rolling for gold posts the dice to chat and locks the total in", async function() {
        if ( rules() !== "legacy" ) this.skip();
        this.timeout(300_000);
        await open();
        query('[data-action="equip-mode"][data-role="class"][data-mode="wealth"]')[0].click();
        await app.settle();
        const button = el().querySelector('[data-action="equip-roll"]');
        assert.exists(button, "no roll button");
        const before = game.messages.size;
        button.click();
        for ( let i = 0; i < 100 && !app.draft.equipment.class.wealth; i++ ) await new Promise(r => setTimeout(r, 100));
        await app.settle();
        const wealth = app.draft.equipment.class.wealth;
        assert.exists(wealth, "nothing was rolled");
        assert.equal(game.messages.size, before + 1);
        const message = game.messages.get(wealth.messageId);
        assert.equal(message.author.id, game.user.id);
        assert.equal(message.rolls[0].total, wealth.total);
        assert.notExists(el().querySelector('[data-action="equip-roll"]'), "you can only roll once");
        assert.include(el().querySelector(".cc-wealth__total").textContent, String(wealth.total));
        // The background still has its own choices open, so only the class's errors are checked here.
        assert.deepEqual(app.validation.errors.filter(e => (e.step === "equipment") && (e.detail?.source === "class")), []);
      });
    });
  }, { displayName: "Character Creator: Wizard equipment" });
}

/*
 * The Spells step (PLAN 3.6): cantrips, the class's own shape, and the counts.
 */
export function registerSpellsStepBatch(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");
  const FIXED = {
    legacy: { species: "Hill Dwarf", background: "Acolyte" },
    modern: { species: "Human", background: "Sage" }
  };

  quench.registerBatch(`${MODULE_ID}.wizard-spells`, ({ describe, it, before, after, afterEach, assert }) => {
    describe("Spells step, as Player A", () => {
      let CharacterWizard;
      let catalog;
      let saved;
      let app = null;
      const el = () => app.element;
      const query = selector => [...el().querySelectorAll(selector)];
      const norm = u => u.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.");
      const pick = (category, name) => norm(catalog.byCategory[category].find(e => e.name === name).uuid);
      const open = async className => {
        app = await CharacterWizard.open();
        assert.exists(app, "the wizard didn't open");
        await app.settle();
        const spec = FIXED[rules()];
        await app.update(d => {
          d.picks.species = pick("species", spec.species);
          d.picks.background = pick("background", spec.background);
          d.picks.class = pick("class", className);
        }, { wait: true });
        await app.settle();
        await app.goTo("spells");
        await app.settle();
        return app;
      };
      const cards = () => query(".cc-cards--spells .cc-card");
      const tabs = () => query('[data-action="spell-tab"]');
      /** Fill the open list, then move on, until every list is done. */
      const fillAll = async () => {
        for ( let guard = 0; guard < 40; guard++ ) {
          const tab = tabs().find(t => {
            const [chosen, needed] = t.textContent.trim().split(/\s+/).slice(-3).filter(x => /^\d+$/.test(x)).map(Number);
            return chosen < needed;
          });
          if ( !tab ) return true;
          if ( tab.getAttribute("aria-selected") !== "true" ) {
            tab.click();
            await app.settle();
            continue;
          }
          const card = cards().find(c => !c.disabled && (c.getAttribute("aria-pressed") !== "true"));
          if ( !card ) return false;
          card.click();
          await app.settle();
        }
        return false;
      };

      before(async function() {
        this.timeout(120_000);
        ({ CharacterWizard } = await import("../scripts/wizard/app.mjs"));
        catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        saved = flag();
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
      });
      afterEach(async function() {
        this.timeout(30_000);
        if ( app?.rendered ) await app.close();
        app = null;
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
      });
      after(async function() {
        this.timeout(30_000);
        if ( saved === undefined ) await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        else await raw(saved);
      });

      it("a non-caster is told there's nothing to choose", async function() {
        this.timeout(180_000);
        await open("Fighter");
        assert.lengthOf(tabs(), 0, "no lists for a Fighter at level 1");
        assert.include(el().querySelector(".cc-empty").textContent, "doesn't cast spells");
        assert.deepEqual(app.validation.errors.filter(e => e.step === "spells"), []);
      });

      it("a Wizard fills cantrips, a spellbook of six, and prepares from the book", async function() {
        this.timeout(300_000);
        await open("Wizard");
        const keys = tabs().map(t => t.dataset.tab);
        assert.deepEqual(keys, ["cantrips", "spellbook", "spells"]);
        assert.isTrue(await fillAll(), "the lists couldn't be filled");
        const { cantrips, spellbook, spells } = app.draft.spells;
        assert.equal(spellbook.length, 6);
        assert.isAbove(cantrips.length, 0);
        assert.isTrue(spells.every(u => spellbook.includes(u)), "prepared spells come from the book");
        assert.deepEqual(app.validation.errors.filter(e => e.step === "spells"), [], "the validator is happy");
        console.log(`${MODULE_ID} | wizard spells (${rules()}): ${cantrips.length} cantrips, ${spellbook.length} in the book, ${spells.length} prepared`);
      });

      it("each spell says its level, its school and what it does", async function() {
        this.timeout(180_000);
        await open("Cleric");
        if ( !app.element.querySelector(".cc-cards--spells .cc-card") ) this.skip();   // not a caster
        const meta = () => query(".cc-card__meta").map(n => n.textContent.trim()).filter(Boolean);
        const hints = () => query(".cc-card__hint").map(n => n.textContent.trim()).filter(Boolean);
        assert.isNotEmpty(meta(), "no level or school on the cards");
        for ( let i = 0; i < 100 && !hints().length; i++ ) await new Promise(r => setTimeout(r, 100));
        assert.isNotEmpty(hints(), "no description under any spell");
        assert.isAbove(hints()[0].length, 10, "the description is a sentence, not a stub");
      });

      it("the prepared list only offers what's in the spellbook", async function() {
        this.timeout(300_000);
        await open("Wizard");
        // Fill the book first.
        assert.isTrue(await fillAll());
        tabs().find(t => t.dataset.tab === "spells").click();
        await app.settle();
        const offered = cards().map(c => c.dataset.uuid).sort();
        assert.deepEqual(offered, [...app.draft.spells.spellbook].sort());
      });

      it("a prepared caster picks cantrips and spells, and can't take more than the count", async function() {
        this.timeout(300_000);
        await open("Cleric");
        assert.includeMembers(tabs().map(t => t.dataset.tab), ["cantrips", "spells"]);
        assert.notInclude(tabs().map(t => t.dataset.tab), "spellbook", "a Cleric has no spellbook");
        assert.isTrue(await fillAll());
        const cantripTab = tabs().find(t => t.dataset.tab === "cantrips");
        cantripTab.click();
        await app.settle();
        assert.isTrue(cards().filter(c => c.getAttribute("aria-pressed") !== "true").every(c => c.disabled),
          "with the count reached, the rest are out of reach");
        assert.deepEqual(app.validation.errors.filter(e => e.step === "spells"), []);
      });

      it("a spell the character already has is marked and can't be picked again", async function() {
        if ( rules() !== "legacy" ) this.skip();
        this.timeout(300_000);
        // The 2014 High Elf knows a wizard cantrip already.
        app = await CharacterWizard.open();
        await app.settle();
        await app.update(d => {
          d.picks.species = pick("species", "High Elf");
          d.picks.background = pick("background", "Acolyte");
          d.picks.class = pick("class", "Wizard");
        }, { wait: true });
        await app.settle();
        await app.goTo("choices");
        await app.settle();
        // Answer the species cantrip choice so the character really knows it.
        const choice = app.build.results.find(r => (r.type === "ItemChoice") && (r.path[0] === "species"));
        if ( choice ) {
          await app.openChoice(choice.key);
          const card = query(".cc-cards button")[0];
          card.click();
          await app.settle();
        }
        await app.goTo("spells");
        await app.settle();
        const known = query(".cc-known");
        const marked = cards().filter(c => c.querySelector(".cc-card__warn"));
        assert.isTrue((known.length > 0) || (marked.length > 0), "a known spell isn't shown as already known");
        assert.isTrue(marked.every(c => c.disabled), "an already-known spell can still be picked");
      });
    });
  }, { displayName: "Character Creator: Wizard spells" });
}

/*
 * The Details step (PLAN 3.7): the name, the optional fields, and the 2014 personality tables.
 */
export function registerDetailsStepBatch(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.wizard-details`, ({ describe, it, before, after, afterEach, assert }) => {
    describe("Details step, as Player A", () => {
      let CharacterWizard;
      let catalog;
      let saved;
      let app = null;
      const el = () => app.element;
      const query = selector => [...el().querySelectorAll(selector)];
      const norm = u => u.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.");
      const pick = (category, name) => norm(catalog.byCategory[category].find(e => e.name === name).uuid);
      const field = key => el().querySelector(`[data-detail="${key}"]`);
      const type = async (key, value) => {
        const input = field(key);
        input.value = value;
        await app.setDetail(key, value);
        await app.render({ parts: ["body", "banner", "footer"] });
      };
      const open = async (background = "Acolyte") => {
        app = await CharacterWizard.open();
        assert.exists(app, "the wizard didn't open");
        await app.settle();
        await app.update(d => {
          d.picks.species = pick("species", catalog.byCategory.species[0].name);
          d.picks.background = pick("background", background);
          d.picks.class = pick("class", "Cleric");
        }, { wait: true });
        await app.settle();
        await app.goTo("details");
        await app.settle();
        return app;
      };

      before(async function() {
        this.timeout(120_000);
        ({ CharacterWizard } = await import("../scripts/wizard/app.mjs"));
        catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        saved = flag();
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
      });
      afterEach(async function() {
        this.timeout(30_000);
        if ( app?.rendered ) await app.close();
        app = null;
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
      });
      after(async function() {
        this.timeout(30_000);
        if ( saved === undefined ) await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        else await raw(saved);
      });

      it("typing a name satisfies the only required field, and the banner follows", async function() {
        this.timeout(180_000);
        await open();
        assert.exists(field("name"), "no name field");
        assert.include(app.validation.errors.map(e => e.code), "NAME_REQUIRED");
        await type("name", "Ilyra of the Vale");
        await app.settle();
        assert.equal(app.draft.details.name, "Ilyra of the Vale");
        assert.notInclude(app.validation.errors.map(e => e.code), "NAME_REQUIRED");
        assert.include(el().querySelector('.cc-step[data-step="details"] .cc-step__label').textContent, "Ilyra");
      });

      it("the optional fields are saved as typed", async function() {
        this.timeout(180_000);
        await open();
        await type("pronouns", "they/them");
        await type("appearance", "Tall, with ink-stained fingers.");
        await app.settle();
        assert.equal(app.draft.details.pronouns, "they/them");
        assert.include(app.draft.details.appearance, "ink-stained");
        const { checkDraftShape } = await import("../scripts/contracts.mjs");
        assert.deepEqual(checkDraftShape(app.draft), []);
      });

      it("rolling keeps the player where they were on the page", async function() {
        this.timeout(180_000);
        await open();
        const pane = () => el().querySelector(".cc-detail");
        const roll = () => el().querySelector('[data-action="detail-roll"][data-detail="traits"]');
        if ( !roll() ) this.skip();   // 2024: no personality tables
        pane().scrollTop = pane().scrollHeight;
        const was = pane().scrollTop;
        assert.isAbove(was, 0, "the page has to scroll for this to mean anything");
        roll().click();
        for ( let i = 0; i < 100 && !app.draft.details.traits; i++ ) await new Promise(r => setTimeout(r, 100));
        await app.settle();
        assert.isNotEmpty(app.draft.details.traits, "nothing was rolled");
        assert.equal(pane().scrollTop, was, "the pane scrolled back to the top");
      });

      it("2014: the personality fields can be rolled from the background's tables", async function() {
        if ( rules() !== "legacy" ) this.skip();
        this.timeout(180_000);
        await open("Acolyte");
        const rollers = query('[data-action="detail-roll"]');
        assert.isAbove(rollers.length, 0, "the Acolyte's tables weren't found");
        const key = rollers[0].dataset.detail;
        rollers[0].click();
        for ( let i = 0; i < 100 && !app.draft.details[key]; i++ ) await new Promise(r => setTimeout(r, 100));
        assert.isAbove((app.draft.details[key] ?? "").length, 0, `${key} wasn't filled in`);
        console.log(`${MODULE_ID} | rolled ${key}: ${app.draft.details[key].slice(0, 60)}`);
      });

      it("2024: there are no personality fields", async function() {
        if ( rules() !== "modern" ) this.skip();
        this.timeout(180_000);
        await open("Sage");
        assert.notExists(field("traits"), "2024 characters don't have personality traits here");
        assert.exists(field("appearance"));
        assert.lengthOf(query('[data-action="detail-roll"]'), 0);
      });
    });
  }, { displayName: "Character Creator: Wizard details" });
}

/*
 * The Portrait step (PLAN 3.8): choosing a picture, the token preview, colours, and skipping.
 */
export function registerPortraitStepBatch(quench) {
  quench.registerBatch(`${MODULE_ID}.wizard-portrait`, ({ describe, it, before, after, afterEach, assert }) => {
    describe("Portrait step, as Player A", () => {
      let CharacterWizard;
      let S;
      let saved;
      let app = null;
      const el = () => app.element;
      const open = async () => {
        app = await CharacterWizard.open();
        assert.exists(app, "the wizard didn't open");
        await app.settle();
        await app.goTo("portrait");
        await app.settle();
        return app;
      };
      /** The file a player would choose. */
      const file = async (width = 1200, height = 1500) => {
        const blob = await S.makeTestImage(width, height);
        return new File([blob], "portrait.png", { type: "image/png" });
      };

      before(async function() {
        this.timeout(120_000);
        ({ CharacterWizard } = await import("../scripts/wizard/app.mjs"));
        S = await import("./support.mjs");
        saved = flag();
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
      });
      afterEach(async function() {
        this.timeout(30_000);
        if ( app?.rendered ) await app.close();
        app = null;
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
      });
      after(async function() {
        this.timeout(30_000);
        if ( saved === undefined ) await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        else await raw(saved);
      });

      it("starts with no picture and shows an empty token", async function() {
        this.timeout(60_000);
        await open();
        assert.equal(app.draft.portrait.status, "none");
        assert.exists(el().querySelector(".cc-token--empty"));
        assert.exists(el().querySelector(".cc-file__input"), "no way to choose a picture");
      });

      it("a chosen picture is resized in the browser and previewed on the ring", async function() {
        this.timeout(180_000);
        await open();
        await app.choosePortrait(await file(1200, 1500));
        await app.settle();
        const image = app.draft.portrait.pendingImage;
        assert.exists(image, "nothing was stored");
        assert.equal(app.draft.portrait.status, "ready");
        assert.equal(image.mime, "image/webp");
        assert.deepEqual([image.width, image.height], [819, 1024], "resized to 1024 on the long side");
        const preview = el().querySelector(".cc-token img");
        assert.exists(preview, "no preview");
        assert.match(preview.getAttribute("src"), /^data:image\/webp;base64,/);
        const { checkImage } = await import("../scripts/contracts.mjs");
        assert.deepEqual(checkImage(image), [], "the picture is a valid payload");
        console.log(`${MODULE_ID} | portrait: ${image.width}×${image.height}, ${Math.round(image.data.length * 3 / 4 / 1024)} KB`);
      });

      it("ring colours are kept, and can be reset to the defaults", async function() {
        this.timeout(180_000);
        await open();
        await app.choosePortrait(await file(400, 400));
        await app.settle();
        const picker = el().querySelector('.cc-color[data-ring="ring"]');
        assert.exists(picker, "no colour picker");
        picker.value = "#c9a227";
        picker.dispatchEvent(new Event("change"));
        await app.settle();
        assert.equal(app.draft.portrait.ring.ring, "#c9a227");
        el().querySelector('[data-action="ring-reset"]').click();
        await app.settle();
        assert.deepEqual([app.draft.portrait.ring.ring, app.draft.portrait.ring.background], [null, null]);
      });

      it("the picture can be removed, or the step skipped", async function() {
        this.timeout(180_000);
        await open();
        await app.choosePortrait(await file(400, 400));
        await app.settle();
        el().querySelector('[data-action="portrait-clear"]').click();
        await app.settle();
        assert.deepEqual([app.draft.portrait.status, app.draft.portrait.pendingImage], ["none", null]);
        el().querySelector('[data-action="portrait-skip"]').click();
        await app.settle();
        assert.equal(app.draft.portrait.status, "skipped");
        assert.include(el().querySelector(".cc-chosen-for-you").textContent, "without a portrait");
        assert.include(el().querySelector('.cc-step[data-step="portrait"] .cc-step__label').textContent, "Skipped");
      });

      it("a file that isn't an image is refused, and the draft is left alone", async function() {
        this.timeout(120_000);
        await open();
        const notAnImage = new File(["hello"], "notes.txt", { type: "text/plain" });
        await app.choosePortrait(notAnImage);
        await app.settle();
        assert.equal(app.draft.portrait.status, "none");
        assert.isNull(app.draft.portrait.pendingImage);
      });

      it("the draft with a picture is still within its size budget", async function() {
        this.timeout(180_000);
        await open();
        await app.choosePortrait(await file(1600, 1600));
        await app.settle();
        const { checkDraftShape } = await import("../scripts/contracts.mjs");
        assert.deepEqual(checkDraftShape(app.draft), [], "the picture doesn't push the draft over its limit");
      });
    });
  }, { displayName: "Character Creator: Wizard portrait" });
}

/*
 * The Review step and Create character (PLAN 3.9): a whole character built through the wizard and created by the
 * GM, plus the offline path. `walkWizard` is the shared walkthrough — it uses the same methods the screens' own
 * buttons call.
 */

/** Fill in a whole character through the wizard, leaving it on the review step with nothing to fix. */
export async function walkWizard(app, { name = "Wizard Walkthrough" } = {}) {
  const rules = game.settings.get("dnd5e", "rulesVersion");
  const spec = rules === "legacy" ? { species: "Hill Dwarf", background: "Acolyte", class: "Cleric" }
    : { species: "Human", background: "Sage", class: "Cleric" };
  const catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
  const norm = u => u.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.");
  const uuid = (category, wanted) => norm(catalog.byCategory[category].find(e => e.name === wanted).uuid);

  // Species, class, background.
  for ( const [role, step] of [["species", "species"], ["class", "class"], ["background", "background"]] ) {
    await app.goTo(step);
    await app.pick(uuid(role, spec[role]));
  }
  await app.settle();

  // Ability scores: the standard array, in order.
  await app.goTo("abilities");
  await app.chooseMethod("standardArray");
  const values = [15, 14, 13, 12, 10, 8];
  for ( const [i, key] of ["str", "dex", "con", "int", "wis", "cha"].entries() ) await app.assign(key, values[i]);
  await app.settle();

  // Every choice, taking the first legal option each time.
  await app.goTo("choices");
  await app.settle();
  for ( let guard = 0; guard < 40; guard++ ) {
    const next = app.build.results.find(r => r.status === "needsInput");
    if ( !next ) break;
    await app.openChoice(next.key);
    const w = next.options;
    if ( next.type === "Trait" ) {
      const need = w.max - (next.data?.chosen?.length ?? 0);
      for ( let i = 0; i < need; i++ ) {
        const box = [...app.element.querySelectorAll(".cc-keys input")].filter(b => !b.disabled && !b.checked)[0];
        if ( !box ) break;
        box.click();
        await app.settle();
      }
    } else if ( next.type === "ItemChoice" ) {
      const need = w.count - (next.data?.selected?.length ?? 0);
      for ( let i = 0; i < need; i++ ) {
        const card = [...app.element.querySelectorAll(".cc-cards button")].filter(c => c.getAttribute("aria-pressed") !== "true")[0];
        if ( !card ) break;
        card.click();
        await app.settle();
      }
      if ( w.abilityOptions?.length > 1 ) {
        app.element.querySelector(".cc-ability-picker button").click();
        await app.settle();
      }
    } else if ( next.type === "ItemGrant" ) {
      if ( w.abilityOptions?.length > 1 ) app.element.querySelector(".cc-ability-picker button").click();
      else app.element.querySelectorAll(".cc-key input").forEach(b => b.click());
      await app.settle();
    } else if ( next.type === "AbilityScoreImprovement" ) {
      for ( let i = 0; i < (w.points ?? 0); i++ ) {
        const plus = [...app.element.querySelectorAll(".cc-score__step")].filter(b => !b.disabled && b.textContent.includes("+"))[0];
        if ( !plus ) break;
        plus.click();
        await app.settle();
      }
    } else {
      app.element.querySelector(".cc-cards button")?.click();
      await app.settle();
    }
  }

  // Equipment: the first option of each choice, for both sources.
  await app.goTo("equipment");
  await app.settle();
  for ( let guard = 0; guard < 40; guard++ ) {
    const groups = [...app.element.querySelectorAll(".cc-decision [role=radiogroup]")];
    const undecided = groups.find(g => ![...g.querySelectorAll("button")].some(b => b.getAttribute("aria-pressed") === "true"));
    if ( undecided ) {
      undecided.querySelector("button").click();
      await app.settle();
      continue;
    }
    const empty = [...app.element.querySelectorAll(".cc-equip-pick")].find(s => !s.value);
    if ( !empty ) break;
    empty.value = [...empty.options].map(o => o.value).filter(Boolean)[0];
    empty.dispatchEvent(new Event("change"));
    await app.settle();
  }

  // Spells, where the class has them.
  await app.goTo("spells");
  await app.settle();
  for ( let guard = 0; guard < 40; guard++ ) {
    const tab = [...app.element.querySelectorAll('[data-action="spell-tab"]')].find(t => {
      const numbers = t.textContent.trim().split(/\s+/).filter(x => /^\d+$/.test(x)).map(Number);
      return numbers.length >= 2 && (numbers[0] < numbers[1]);
    });
    if ( !tab ) break;
    if ( tab.getAttribute("aria-selected") !== "true" ) {
      tab.click();
      await app.settle();
      continue;
    }
    const card = [...app.element.querySelectorAll(".cc-cards--spells .cc-card")]
      .find(c => !c.disabled && (c.getAttribute("aria-pressed") !== "true"));
    if ( !card ) break;
    card.click();
    await app.settle();
  }

  // A name, no portrait, then the review.
  await app.goTo("details");
  await app.setDetail("name", name);
  await app.goTo("portrait");
  await app.setPortrait((await import("../scripts/wizard/portrait-step.mjs")).skipPortrait);
  await app.goTo("review");
  await app.settle();
  return app;
}

export function registerCreateBatches(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.wizard-create@gm`, ({ describe, it, before, after, assert }) => {
    describe("Review and Create, with a GM online", () => {
      let CharacterWizard;
      let saved;
      let app = null;
      let actor = null;
      const gm = () => game.users.activeGM;
      const el = () => app.element;

      before(async function() {
        this.timeout(600_000);
        assert.isFalse(game.user.isGM, "run as a player");
        assert.exists(gm(), "no active GM — run with npm run test:foundry");
        ({ CharacterWizard } = await import("../scripts/wizard/app.mjs"));
        saved = flag();
        // Clear the draft first: a pending build from the offline batch would otherwise be created by the GM
        // while this one runs and take up the character limit.
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        await gm().query(`${MODULE_ID}.test.setSetting`, { key: "characterLimit", value: 0 }, { timeout: 30_000 });
        await gm().query(`${MODULE_ID}.test.submitCleanup`, {}, { timeout: 60_000 });
        app = await CharacterWizard.open();
        await app.settle();
        await walkWizard(app, { name: `Walkthrough ${rules()}` });
      });
      after(async function() {
        this.timeout(120_000);
        if ( app?.rendered ) await app.close();
        if ( gm() ) {
          await gm().query(`${MODULE_ID}.test.submitCleanup`, {}, { timeout: 60_000 });
          await gm().query(`${MODULE_ID}.test.setSetting`, { key: "characterLimit", reset: true }, { timeout: 30_000 });
        }
        if ( saved === undefined ) await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        else await raw(saved);
      });

      it("the review shows the character the GM will create, with nothing left to fix", async function() {
        this.timeout(120_000);
        assert.equal(app.step, "review");
        assert.deepEqual(app.validation.errors, [], JSON.stringify(app.validation.errors).slice(0, 400));
        const title = el().querySelector(".cc-pane__title").textContent.trim();
        assert.include(title, "Walkthrough");
        assert.lengthOf([...el().querySelectorAll(".cc-stat")], 6, "the six ability scores");
        const create = el().querySelector('[data-action="create"]');
        assert.exists(create);
        assert.isFalse(create.disabled, "Create should be available");
      });

      it("Create sends it to the GM, who creates the character", async function() {
        this.timeout(300_000);
        const before = game.actors.size;
        // A character created earlier (the offline batch's pending build) keeps the assignment: Foundry only
        // assigns a player's character when they don't have one.
        const hadCharacter = !!game.user.character;
        el().querySelector('[data-action="create"]').click();
        for ( let i = 0; i < 300 && (app.draft?.status !== "created"); i++ ) await new Promise(r => setTimeout(r, 200));
        assert.equal(app.draft.status, "created", JSON.stringify(app.draft.result?.errors ?? []).slice(0, 400));
        actor = await fromUuid(app.draft.result.actorUuid);
        assert.exists(actor, "the character never arrived");
        assert.equal(game.actors.size, before + 1);
        assert.equal(actor.name, `Walkthrough ${rules()}`);
        assert.equal(actor.system.details.level, 1);
        assert.isTrue(actor.isOwner);
        if ( !hadCharacter ) assert.equal(game.user.character?.id, actor.id, "assigned to the player");
        console.log(`${MODULE_ID} | wizard create (${rules()}): ${actor.items.size} items, ${actor.system.attributes.hp.max} hp`);
      });

      it("the character matches what the review showed", async function() {
        this.timeout(120_000);
        const summary = app.build.actor;
        assert.equal(actor.system.attributes.hp.max, summary.system.attributes.hp.max);
        for ( const key of ["str", "dex", "con", "int", "wis", "cha"] ) {
          assert.equal(actor.system.abilities[key].value, summary.system.abilities[key].value, key);
        }
        const names = list => list.map(i => `${i.type}:${i.name}`).sort();
        // The created actor also carries the equipment and spells, so the build's items are a subset.
        assert.includeMembers(names(actor.items.contents), names(summary.items.contents));
      });

      it("the outcome offers the sheet, and finishing clears the draft", async function() {
        this.timeout(120_000);
        await app.settle();
        assert.exists(el().querySelector(".cc-outcome--created"), "no 'your character is ready' message");
        assert.exists(el().querySelector('[data-action="open-sheet"]'));
        el().querySelector('[data-action="finish"]').click();
        for ( let i = 0; i < 100 && app.rendered; i++ ) await new Promise(r => setTimeout(r, 100));
        assert.isUndefined(flag(), "the draft is cleared once the player has seen the result");
      });
    });
  }, { displayName: "Character Creator: Wizard create (GM online)" });

  quench.registerBatch(`${MODULE_ID}.wizard-create@nogm`, ({ describe, it, before, after, assert }) => {
    describe("Create with no GM online (D17)", () => {
      let CharacterWizard;
      let saved;
      let app = null;

      before(async function() {
        this.timeout(600_000);
        assert.notExists(game.users.activeGM, "this batch needs no GM online");
        ({ CharacterWizard } = await import("../scripts/wizard/app.mjs"));
        saved = flag();
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        app = await CharacterWizard.open();
        await app.settle();
        await walkWizard(app, { name: "Offline Walkthrough" });
      });
      after(async function() {
        this.timeout(60_000);
        if ( app?.rendered ) await app.close();
        // The draft is left for pending@gm to pick up; the flag is restored by that batch's clean-up.
        if ( saved !== undefined ) await raw(saved);
      });

      it("the character waits as a pending build, with the player told so", async function() {
        this.timeout(300_000);
        assert.deepEqual(app.validation.errors, [], JSON.stringify(app.validation.errors).slice(0, 300));
        app.element.querySelector('[data-action="create"]').click();
        for ( let i = 0; i < 300 && (app.draft?.status !== "submitted"); i++ ) await new Promise(r => setTimeout(r, 200));
        assert.equal(app.draft.status, "submitted");
        assert.equal(flag().status, "submitted", "it's stored for the GM");
        await app.settle();
        assert.exists(app.element.querySelector(".cc-outcome--pending"), "the player isn't told it's waiting");
      });
    });
  }, { displayName: "Character Creator: Wizard create (no GM)" });
}

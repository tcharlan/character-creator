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
      const open = async () => {
        app = await CharacterWizard.open();
        assert.exists(app, "the wizard didn't open");
        return settled(app);
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
        assert.include(el().querySelector(".cc-pane__title").textContent, "Species");
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

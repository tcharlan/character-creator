import { MODULE_ID } from "../scripts/main.mjs";
import { DRAFT_FLAG, ABILITIES } from "../scripts/contracts.mjs";
import { SETTINGS_TEST_QUERIES } from "./settings.mjs";

/*
 * The random character (D31), as a player with a GM online: the dice make the whole character, the rolls go to
 * chat, the rolled steps are closed to the player, the GM's copy accepts it — and refuses one that has been
 * changed afterwards. The player's draft, the setting and anything created are put back afterwards.
 */

const flag = () => game.user.getFlag(MODULE_ID, DRAFT_FLAG);
const raw = value => game.user.update({ [`flags.${MODULE_ID}.${DRAFT_FLAG}`]: foundry.data.operators.ForcedReplacement.create(value) });
const wait = ms => new Promise(r => setTimeout(r, ms));

export function registerHardcoreBatches(quench) {
  quench.registerBatch(`${MODULE_ID}.hardcore@gm`, ({ describe, it, before, after, afterEach, assert }) => {
    describe("The random character (D31), as a player", () => {
      let CharacterWizard;
      let app = null;
      let saved;
      const made = [];
      const gm = () => game.users.activeGM;
      const setHardcore = free => gm().query(SETTINGS_TEST_QUERIES.SET,
        { key: "hardcore", value: { offered: true, free } }, { timeout: 60_000 });
      const open = async () => {
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        app = await CharacterWizard.open();
        assert.exists(app, "the creator didn't open");
        await app.settle();
        return app;
      };
      const rollOne = async () => {
        await open();
        const button = app.element.querySelector('[data-action="roll-character"]');
        assert.exists(button, "the start screen should offer a random character");
        button.click();
        for ( let i = 0; i < 600 && (app.draft?.mode !== "hardcore"); i++ ) await wait(200);
        assert.equal(app.draft.mode, "hardcore", "nothing was rolled");
        await app.settle();
        return app.draft;
      };

      before(async function() {
        this.timeout(120_000);
        assert.isFalse(game.user.isGM, "run as a player");
        assert.exists(gm(), "no active GM — run with npm run test:foundry");
        ({ CharacterWizard } = await import("../scripts/wizard/app.mjs"));
        saved = flag();
        await setHardcore([]);
        await gm().query(`${MODULE_ID}.test.setSetting`, { key: "characterLimit", value: 0 }, { timeout: 30_000 });
      });
      afterEach(async function() {
        this.timeout(60_000);
        if ( app?.rendered ) await app.close();
        app = null;
      });
      after(async function() {
        this.timeout(120_000);
        await setHardcore([]);
        await gm().query(SETTINGS_TEST_QUERIES.SET, { key: "hardcore", reset: true }, { timeout: 60_000 });
        await gm().query(SETTINGS_TEST_QUERIES.SET, { key: "characterLimit", reset: true }, { timeout: 60_000 });
        await gm().query(`${MODULE_ID}.test.submitCleanup`, {}, { timeout: 60_000 });
        if ( saved === undefined ) await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        else await raw(saved);
        assert.isAtLeast(made.length, 0);
      });

      it("the dice make a whole character, and the rolls are in chat", async function() {
        this.timeout(600_000);
        const draft = await rollOne();
        assert.ok(draft.picks.species && draft.picks.class && draft.picks.background, "species, class and background");
        assert.equal(draft.abilities.method, "rolled");
        assert.deepEqual(ABILITIES.map(k => draft.abilities.base[k]), draft.abilities.roll.results,
          "the scores are the ones that fell, in order");
        assert.isAbove(draft.random.rolls.length, 3, "a die for each decision");
        for ( const role of ["class", "background"] ) {
          const chosen = draft.equipment[role];
          if ( chosen ) assert.equal(chosen.mode, "items", role + ": the gear, not the gold");
        }
        const message = game.messages.get(draft.random.messageId);
        assert.exists(message, "the rolls should be in chat");
        assert.equal(message.rolls.length, draft.random.rolls.length);
        assert.isEmpty(message.whisper, "and public");
        assert.equal(app.step, "review", "it drops the player at the end");
      });

      it("the name and the rest of the details are still the player's", async function() {
        this.timeout(600_000);
        const draft = await rollOne();
        await app.goTo("details");
        await app.settle();
        await app.setDetail("name", "Named By Hand");
        await app.settle();
        assert.equal(app.draft.details.name, "Named By Hand", "a rolled character can still be named");
        await app.setDetail("eyes", "grey");
        await app.settle();
        assert.equal(app.draft.details.eyes, "grey", "and described");
        const alignment = draft.details.alignment;
        await app.setDetail("alignment", "Lawful Good");
        await app.settle();
        assert.equal(app.draft.details.alignment, alignment, "but the alignment is the dice's");
        const name = app.element.querySelector('[data-detail="name"]');
        assert.exists(name);
        assert.isFalse(name.readOnly, "the name field can be typed in");
        const field = app.element.querySelector('[data-detail="alignment"]');
        if ( field ) assert.isTrue(field.disabled || field.readOnly, "the alignment field is closed");
      });

      it("a rolled step is closed to the player", async function() {
        this.timeout(600_000);
        const draft = await rollOne();
        const species = draft.picks.species;
        const other = (await (await import("../scripts/catalog/catalog.mjs")).getCatalog())
          .byCategory.species.map(e => e.uuid).find(u => u !== species);
        await app.goTo("species");
        await app.settle();
        assert.exists(app.element.querySelector(".cc-pane--rolled"), "the pane says the dice chose it");
        await app.pick(other);
        await app.settle();
        assert.equal(app.draft.picks.species, species, "the pick didn't change");
      });

      it("the GM's copy creates it, and refuses one that was changed after the rolls", async function() {
        this.timeout(900_000);
        const draft = await rollOne();
        // Spells stay the player's, so a caster still has to pick them before it can be created.
        const { fillSpells } = await import("./wizard.mjs");
        await fillSpells(app);
        await app.goTo("details");
        await app.setDetail("name", "Fate's Own");
        await app.goTo("portrait");
        await app.setPortrait((await import("../scripts/wizard/portrait-step.mjs")).skipPortrait);
        await app.goTo("review");
        await app.settle();
        assert.deepEqual(app.validation.errors, [], JSON.stringify(app.validation.errors).slice(0, 300));

        // Changed afterwards: the same rolls, a different species.
        const { submitDraft } = await import("../scripts/gm/pending.mjs");
        const catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        const other = catalog.byCategory.species.map(e => e.uuid).find(u => u !== draft.picks.species);
        if ( other ) {
          const tampered = foundry.utils.deepClone(app.draft);
          tampered.picks.species = other;
          const refused = await submitDraft(tampered, { timeout: 120_000 });
          assert.isFalse(refused.ok, "a character that doesn't match its rolls should be refused");
          assert.include(refused.errors.map(e => e.code), "RANDOM_INVALID");
        }

        // As rolled: created.
        app.element.querySelector('[data-action="create"]')?.click();
        for ( let i = 0; i < 600 && (app.draft?.status !== "created"); i++ ) await wait(200);
        assert.equal(app.draft.status, "created", JSON.stringify(app.draft.result?.errors ?? []).slice(0, 400));
        const actor = await fromUuid(app.draft.result.actorUuid);
        assert.exists(actor, "the character was never made");
        made.push(actor.id);
        assert.equal(actor.name, "Fate's Own");
      });

      it("a part the GM leaves to the player is not rolled", async function() {
        this.timeout(600_000);
        await setHardcore(["class"]);
        for ( let i = 0; i < 50 && (game.settings.get(MODULE_ID, "hardcore").free.length === 0); i++ ) await wait(100);
        const draft = await rollOne();
        assert.equal(draft.picks.class, null, "the class is the player's to choose");
        assert.ok(draft.picks.species, "the rest is still rolled");
        assert.isFalse(draft.random.rolls.some(r => r.key === "class"));
        await app.goTo("class");
        await app.settle();
        assert.notExists(app.element.querySelector(".cc-pane--rolled"), "and the step is open");
        const pick = (await (await import("../scripts/catalog/catalog.mjs")).getCatalog()).byCategory.class[0]?.uuid;
        await app.pick(pick);
        await app.settle();
        assert.ok(app.draft.picks.class, "the player can pick one");
        await setHardcore([]);
      });
    });
  }, { displayName: "Character Creator: the random character" });
}

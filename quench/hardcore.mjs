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
      const setHardcore = (free, attempts = 1) => gm().query(SETTINGS_TEST_QUERIES.SET,
        { key: "hardcore", value: { offered: true, free, attempts } }, { timeout: 60_000 });
      // The setting is the GM's; wait for this client's copy of it to arrive.
      const awaitSetting = async test => {
        for ( let i = 0; i < 100 && !test(game.settings.get(MODULE_ID, "hardcore")); i++ ) await wait(100);
        assert.isTrue(test(game.settings.get(MODULE_ID, "hardcore")), "the setting never reached the player");
      };
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
        staged = await answerStages(app);
        return app.draft;
      };
      let staged = false;

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
        const messages = draft.random.messageIds.map(id => game.messages.get(id));
        assert.notInclude(messages, undefined, "the rolls should be in chat");
        assert.equal(messages.reduce((n, m) => n + m.rolls.length, 0), draft.random.rolls.length);
        for ( const message of messages ) assert.isEmpty(message.whisper, "and public");
        // A 2014 Cleric, Sorcerer or Warlock picks its subclass from the dice's shortlist first (D39).
        if ( !staged ) assert.equal(app.step, "review", "it drops the player at the end");
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

      it("a rolled character can't be discarded, and a reroll is the GM's to allow", async function() {
        this.timeout(900_000);
        // The default: one roll, which is the character.
        const first = await rollOne();
        assert.equal(first.random.attempt, 1);
        assert.notExists(app.element.querySelector('[data-action="discard"]'),
          "a rolled character can't be thrown away and rolled again from a new draft");
        assert.notExists(app.element.querySelector('[data-action="reroll"]'), "and no reroll is on offer");
        await app.discardAndClose();
        assert.exists(app.draft, "discarding does nothing");
        assert.equal(app.draft.mode, "hardcore");

        // Two goes: the reroll appears, rolls everything again and says so in chat.
        await setHardcore([], 2);
        await awaitSetting(s => s.attempts === 2);
        await app.render({ parts: ["body", "footer"] });
        assert.exists(app.element.querySelector('[data-action="reroll"]'), "the reroll should be offered");
        const hook = Hooks.on("renderDialogV2", dialog => dialog.element.querySelector('[data-action="yes"]')?.click());
        try {
          await app.rerollRandomCharacter();
        } finally {
          Hooks.off("renderDialogV2", hook);
        }
        for ( let i = 0; i < 600 && (app.draft.random?.attempt !== 2); i++ ) await wait(200);
        assert.equal(app.draft.random.attempt, 2, "the second go was never rolled");
        assert.notDeepEqual(app.draft.random.messageIds, first.random.messageIds, "its rolls are its own");
        const message = game.messages.get(app.draft.random.messageIds[0]);
        assert.equal(message.getFlag(MODULE_ID, "roll")?.attempt, 2, "the message says which go it was");
        assert.ok(app.draft.picks.species && app.draft.picks.class, "a whole character again");
        assert.equal(app.draft.abilities.method, "rolled", "the scores were rolled again too");
        assert.notEqual(app.draft.abilities.roll.messageId, first.abilities.roll.messageId);

        // That was the second of two: no more.
        await app.settle();
        assert.notExists(app.element.querySelector('[data-action="reroll"]'), "no goes left");
        await setHardcore([]);
        await awaitSetting(s => s.attempts === 1);
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

        // What that class brought with it — its own choices, its kit — is the dice's, not the player's, so it
        // is rolled as soon as it appears and posted as another message.
        for ( let i = 0; i < 300 && (app.draft.random.messageIds.length < 2); i++ ) await wait(200);
        assert.lengthOf(app.draft.random.messageIds, 2, "the new decisions were never rolled");
        const added = app.draft.random.rolls.slice(draft.random.rolls.length);
        assert.isNotEmpty(added, "and their dice were recorded");
        assert.isEmpty(app.build.results.filter(r => r.status === "needsInput"),
          "the class's own choices are settled: " + JSON.stringify(app.build.results
            .filter(r => r.status === "needsInput").map(r => r.title)));
        assert.equal(app.draft.equipment.class?.mode, "items", "and it starts with the class's gear");
        const message = game.messages.get(app.draft.random.messageIds.at(-1));
        assert.equal(message.rolls.length, added.length, "the message holds exactly the new dice");
        await app.goTo("review");
        await app.settle();
        for ( const part of ["choices", "equipment"] ) {
          assert.isEmpty(app.validation.errors.filter(e => e.step === part),
            part + " should be settled: " + JSON.stringify(app.validation.errors).slice(0, 200));
        }
        await setHardcore([]);
      });
    });
  }, { displayName: "Character Creator: the random character" });
}

/**
 * Answer every shortlist a random character stops at (D35, D36, D39) the way a quick player would: the first
 * subclass or feat on offer, the scores for an increase, one class kept at the multiclass stage. Returns whether
 * there was any.
 */
export async function answerStages(app) {
  const { openStage } = await import("../scripts/rules/random.mjs");
  // A click from a test goes through whatever the page's styles say; a player's doesn't. What the player has to
  // reach must not be switched off.
  const reachable = element => {
    for ( let e = element; e; e = e.parentElement ) {
      if ( getComputedStyle(e).pointerEvents === "none" ) throw new Error(`a player can't click ${element.outerHTML.slice(0, 120)}`);
    }
    return element;
  };
  let any = false;
  for ( let guard = 0; guard < 20; guard++ ) {
    const stage = openStage(app.draft, app.build);
    if ( !stage ) break;
    any = true;
    if ( stage.kind === "multiclass" ) {
      await app.goTo("class");
      await app.finishClassStage();
    } else {
      await app.goTo("choices");
      reachable(app.element.querySelector(`[data-action="choice"][data-key="${stage.key}"]`)).click();
      await app.settle();
      if ( stage.kind === "subclass" ) reachable(app.element.querySelector('[data-action="subclass-choice"]'))?.click();
      else {
        reachable(app.element.querySelector('[data-action="asi-mode"][data-key="feat"]') ?? app.element.querySelector(".cc-scores"));
        for ( let i = 0; i < 4; i++ ) {
          const plus = [...app.element.querySelectorAll('[data-action="asi-raise"]')].find(b => !b.disabled);
          if ( !plus ) break;
          reachable(plus).click();
          await app.settle();
        }
      }
    }
    await app.settle();
    // The dice carry on from the pick.
    for ( let i = 0; i < 100 && (app.busy ?? false); i++ ) await new Promise(r => setTimeout(r, 200));
    await app.settle();
  }
  return any;
}

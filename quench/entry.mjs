import { MODULE_ID } from "../scripts/main.mjs";
import { DRAFT_FLAG } from "../scripts/contracts.mjs";
import { SUBMIT_TEST_QUERIES } from "./submit.mjs";
import { SETTINGS_TEST_QUERIES } from "./settings.mjs";
import { ABILITY_TEST_QUERIES } from "./abilities.mjs";
import { legitDraft } from "./validator.mjs";

/*
 * The entry points (PLAN 3.10) as Player A: the Actors sidebar button, what it says as the draft moves along,
 * the character limit hiding it, and the once-a-session prompt. A GM must be online for the limit test, which
 * really creates a character.
 */

const FIXED = {
  legacy: { species: "High Elf", background: "Acolyte", class: "Wizard" },
  modern: { species: "Human", background: "Sage", class: "Cleric" }
};
const flag = () => game.user.getFlag(MODULE_ID, DRAFT_FLAG);
const raw = value => game.user.update({ [`flags.${MODULE_ID}.${DRAFT_FLAG}`]: foundry.data.operators.ForcedReplacement.create(value) });
const button = () => ui.actors?.element?.querySelector(".cc-entry") ?? null;
const label = () => button()?.textContent.trim() ?? null;
const T = key => game.i18n.localize(key);
const wizard = () => foundry.applications.instances.get("character-creator-wizard") ?? null;

/** Wait for `check()` to be true (the hooks that refresh the button run on their own). */
async function until(check, { tries = 100, wait = 50 } = {}) {
  for ( let i = 0; i < tries; i++ ) {
    if ( check() ) return true;
    await new Promise(r => setTimeout(r, wait));
  }
  return false;
}

export function registerEntryBatches(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.entry@gm`, ({ describe, it, before, after, afterEach, assert }) => {
    describe("Entry points (scripts/ui), as Player A", () => {
      let saved;
      let catalog;
      const draftIds = [];
      const gm = () => game.users.activeGM;
      const cleanup = () => gm().query(SUBMIT_TEST_QUERIES.CLEANUP, {}, { timeout: 60_000 });
      const closeWizard = async () => {
        const app = wizard();
        if ( app?.rendered ) await app.close();
      };

      before(async function() {
        this.timeout(180_000);
        assert.isFalse(game.user.isGM, "run as a player");
        assert.exists(gm(), "no active GM — run with npm run test:foundry");
        saved = flag();
        catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        await cleanup();
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        // The sidebar is where the button goes; make sure the tab has rendered at least once.
        if ( !ui.actors.rendered ) await ui.actors.render({ force: true });
        assert.isTrue(await until(() => button()), "no button for a player with no character and no draft");
      });
      afterEach(async function() {
        this.timeout(60_000);
        await closeWizard();
        document.querySelectorAll("#notifications li.notification").forEach(li => li.remove());
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
      });
      after(async function() {
        this.timeout(120_000);
        await closeWizard();
        if ( gm() ) {
          await cleanup();
          await gm().query(ABILITY_TEST_QUERIES.CLEANUP, { draftIds }, { timeout: 30_000 });
        }
        if ( saved === undefined ) await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        else await raw(saved);
      });

      it("the Actors sidebar offers a character, and the button opens the wizard", async function() {
        this.timeout(60_000);
        assert.exists(button(), "no button in the Actors sidebar");
        assert.equal(label(), T("CHARCREATOR.Entry.create.Button"));
        assert.equal(button().dataset.tooltip, T("CHARCREATOR.Entry.create.Tooltip"));
        button().click();
        assert.isTrue(await until(() => wizard()?.rendered, { tries: 200 }), "the wizard did not open");
        assert.exists(flag(), "opening it starts a draft");
      });

      it("the label follows the draft, from a fresh one to the character the GM made", async function() {
        this.timeout(300_000);
        // A build left waiting by an earlier run is created as soon as the GM joins: start from nothing.
        await cleanup();
        assert.isTrue(await until(() => !!button(), { tries: 200 }), "the player should start with no character");
        const draft = await legitDraft(FIXED[rules()], { catalog });
        draftIds.push(draft.id);
        await raw(draft);
        assert.isTrue(await until(() => label() === T("CHARCREATOR.Entry.continue.Button")), `still "${label()}"`);
        // What the wizard stores when it is sent with no GM online (D17); the GM's processor takes it from here.
        await raw({ ...draft, status: "submitted" });
        const sent = [T("CHARCREATOR.Entry.waiting.Button"), T("CHARCREATOR.Entry.ready.Button")];
        // The GM may have made it already by the time we look, so either answer is right here.
        assert.isTrue(await until(() => sent.includes(label())), `still "${label()}"`);
        assert.isTrue(await until(() => flag()?.status === "created", { tries: 600, wait: 250 }),
          "the GM never picked up the pending build");
        assert.isTrue(await until(() => label() === T("CHARCREATOR.Entry.ready.Button")),
          "the character the GM made should be offered");
        // Opening it hands the character over and lets the draft go; that leaves the player at the limit.
        button().click();
        assert.isTrue(await until(() => flag() === undefined), "the created draft should be cleared once seen");
        assert.isTrue(await until(() => !button(), { tries: 200 }), "at the limit there is nothing to start");
        await cleanup();
        assert.isTrue(await until(() => !!button(), { tries: 200 }), "and it is back once the character is gone");
        assert.equal(label(), T("CHARCREATOR.Entry.create.Button"));
      });

      it("the prompt carries the same button, and the GM can turn it off", async function() {
        this.timeout(120_000);
        const { promptOnLogin } = await import("../scripts/ui/entry-ui.mjs");
        await cleanup();
        assert.isTrue(await until(() => !game.user.character, { tries: 200 }));
        assert.notExists(game.user.character, "the player should have no character for this test");
        assert.exists(promptOnLogin(), "no prompt for a player without a character");
        assert.isTrue(await until(() => document.querySelector("#notifications [data-cc-entry]")),
          "the prompt has no button");
        document.querySelector("#notifications [data-cc-entry]").click();
        assert.isTrue(await until(() => wizard()?.rendered, { tries: 200 }), "the prompt did not open the wizard");
        await closeWizard();
        await gm().query(SETTINGS_TEST_QUERIES.SET, { key: "showOnLogin", value: false }, { timeout: 60_000 });
        try {
          await until(() => game.settings.get(MODULE_ID, "showOnLogin") === false);
          await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
          assert.notExists(promptOnLogin(), "the prompt should be off");
        } finally {
          await gm().query(SETTINGS_TEST_QUERIES.SET, { key: "showOnLogin", reset: true }, { timeout: 60_000 });
        }
      });
    });
  }, { displayName: "Character Creator: Entry points" });
}

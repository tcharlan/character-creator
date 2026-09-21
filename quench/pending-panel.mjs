import { MODULE_ID } from "../scripts/main.mjs";
import { DRAFT_FLAG } from "../scripts/contracts.mjs";
import { legitDraft } from "./validator.mjs";

/*
 * The GM's pending-characters panel (PLAN 4.2): what a GM still has to do, with the validator's reasons, the
 * sidebar count, and trying a refused build again. Runs in the GM's own session.
 */

const FIXED = {
  legacy: { species: "High Elf", background: "Acolyte", class: "Wizard" },
  modern: { species: "Human", background: "Sage", class: "Cleric" }
};

export function registerPendingPanelBatches(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.pending-panel@gmpage`, ({ describe, it, before, after, afterEach, assert }) => {
    describe("Pending characters (scripts/gm), on the GM", () => {
      let PendingApp;
      let catalog;
      let player;
      let saved;
      let app = null;
      const el = () => app.element;
      const rows = () => [...el().querySelectorAll(".cc-queue__row")];
      const setDraft = draft => player.setFlag(MODULE_ID, DRAFT_FLAG, draft);
      const clearDraft = () => player.unsetFlag(MODULE_ID, DRAFT_FLAG);
      /** Characters this module made for the player, and the assignment, gone. */
      const cleanup = async () => {
        const ids = game.actors.filter(a => a.getFlag(MODULE_ID, "created")?.userId === player.id).map(a => a.id);
        if ( player.character && ids.includes(player.character.id) ) await player.update({ character: null });
        if ( ids.length ) await Actor.implementation.deleteDocuments(ids);
      };

      before(async function() {
        this.timeout(180_000);
        assert.isTrue(game.user.isGM, "this panel is the GM's");
        ({ PendingApp } = await import("../scripts/gm/pending-app.mjs"));
        catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        // The runner says whose run this is; never guess, since the clean-up deletes that player's characters.
        player = (globalThis.ccTestPlayer ? game.users.getName(globalThis.ccTestPlayer) : null)
          ?? game.users.find(u => !u.isGM && u.active) ?? game.users.find(u => !u.isGM);
        assert.exists(player, "no player in this world");
        saved = player.getFlag(MODULE_ID, DRAFT_FLAG);
        await clearDraft();
        await cleanup();
      });
      afterEach(async function() {
        this.timeout(120_000);
        if ( app?.rendered ) await app.close();
        app = null;
        await clearDraft();
        await cleanup();
      });
      after(async function() {
        this.timeout(120_000);
        if ( saved === undefined ) await clearDraft();
        else await player.setFlag(MODULE_ID, DRAFT_FLAG, saved);
      });

      it("says so when there is nothing to do", async function() {
        this.timeout(60_000);
        app = await PendingApp.open();
        assert.exists(app, "the panel didn't open");
        assert.isEmpty(rows());
        assert.exists(el().querySelector(".cc-empty"));
        assert.notExists(el().querySelector('[data-action="all"]'), "nothing to create");
      });

      it("shows a refused build with the validator's reasons, and only offers to try it again", async function() {
        this.timeout(180_000);
        const draft = await legitDraft(FIXED[rules()], { catalog });
        await setDraft({ ...draft, status: "failed", details: { ...draft.details, name: "Refused One" },
          result: { actorUuid: null, errors: [{ code: "NAME_REQUIRED", step: "details",
            key: "CHARCREATOR.Error.NAME_REQUIRED" }] } });
        app = await PendingApp.open();
        assert.lengthOf(rows(), 1);
        const row = rows()[0];
        assert.include(row.textContent, player.name);
        assert.include(row.textContent, "Refused One");
        assert.include(row.textContent, game.i18n.localize("CHARCREATOR.Error.NAME_REQUIRED"));
        assert.include(row.textContent, game.i18n.localize("CHARCREATOR.Step.details.Title"), "which step to fix");
        const picks = row.querySelector(".cc-queue__picks");
        assert.exists(picks, "the row should say what they were making");
        assert.include(picks.textContent, FIXED[rules()].class);
        assert.exists(row.querySelector('[data-action="retry"]'));
        assert.notExists(row.querySelector('[data-action="create"]'), "the player has to fix it first");
      });

      it("trying again sends it back through the same path, and the character is made", async function() {
        this.timeout(300_000);
        const draft = await legitDraft(FIXED[rules()], { catalog });
        // Refused for something the GM has since put right: the draft itself is sound.
        await setDraft({ ...draft, status: "failed", details: { ...draft.details, name: "Second Chance" },
          result: { actorUuid: null, errors: [{ code: "CLASS_NOT_ALLOWED", step: "class",
            key: "CHARCREATOR.Error.CLASS_NOT_ALLOWED" }] } });
        app = await PendingApp.open();
        assert.lengthOf(rows(), 1);
        rows()[0].querySelector('[data-action="retry"]').click();
        for ( let i = 0; i < 300; i++ ) {
          if ( player.getFlag(MODULE_ID, DRAFT_FLAG)?.status === "created" ) break;
          await new Promise(r => setTimeout(r, 200));
        }
        const result = player.getFlag(MODULE_ID, DRAFT_FLAG);
        assert.equal(result.status, "created", JSON.stringify(result.result?.errors ?? []).slice(0, 300));
        const actor = await fromUuid(result.result.actorUuid);
        assert.exists(actor, "the character was never made");
        assert.equal(actor.name, "Second Chance");
        assert.equal(actor.getFlag(MODULE_ID, "created")?.userId, player.id);
        await app.render({ parts: ["body"] });
        assert.isEmpty(rows(), "and the panel has nothing left to do");
      });

      it("the Actors sidebar tells the GM how many are waiting, and opens the panel", async function() {
        this.timeout(120_000);
        const { refreshEntryPoints } = await import("../scripts/ui/entry-ui.mjs");
        const draft = await legitDraft(FIXED[rules()], { catalog });
        if ( !ui.actors.rendered ) await ui.actors.render({ force: true });
        refreshEntryPoints();
        assert.notExists(ui.actors.element.querySelector(".cc-entry"), "nothing waiting, nothing shown");

        await setDraft({ ...draft, status: "failed",
          result: { actorUuid: null, errors: [{ code: "NAME_REQUIRED", step: "details",
            key: "CHARCREATOR.Error.NAME_REQUIRED" }] } });
        refreshEntryPoints();
        const button = ui.actors.element.querySelector(".cc-entry");
        assert.exists(button, "the GM should see what is waiting");
        assert.include(button.textContent, "1");
        button.click();
        for ( let i = 0; i < 100 && !PendingApp.open.length; i++ ) await new Promise(r => setTimeout(r, 50));
        await new Promise(r => setTimeout(r, 500));
        app = foundry.applications.instances.get("character-creator-pending") ?? null;
        assert.exists(app, "the button didn't open the panel");
        assert.lengthOf(rows(), 1);
      });
    });
  }, { displayName: "Character Creator: Pending characters (GM)" });
}

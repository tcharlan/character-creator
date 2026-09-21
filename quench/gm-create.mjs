import { MODULE_ID } from "../scripts/main.mjs";
import { DRAFT_FLAG } from "../scripts/contracts.mjs";

/*
 * A GM's own characters (D29), on the GM: the Actors tab offers the creator, a character made with "for me" stays
 * the GM's (and isn't the GM's assigned character), the player limit doesn't apply, a player chosen at Review gets
 * it, and "Give to a player…" works later from the Actors tab. Everything made here is deleted afterwards and the
 * test player's own character is put back.
 */

const wait = ms => new Promise(r => setTimeout(r, ms));

export function registerGmCreateBatches(quench) {
  quench.registerBatch(`${MODULE_ID}.gm-create@gmpage`, ({ describe, it, before, after, afterEach, assert }) => {
    describe("A GM's own characters (D29), on the GM", () => {
      let CharacterWizard;
      let walkWizard;
      let assign;
      let app = null;
      let player;
      let savedDraft;
      let savedCharacter;
      let savedLimit;
      const made = [];
      const flag = () => game.user.getFlag(MODULE_ID, DRAFT_FLAG);

      /** Walk the creator as the GM and press Create; returns the new actor. */
      const makeOne = async (name, forPlayer = null) => {
        // A finished draft opens the finished character instead of the creator (as for a player): start fresh.
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        app = await CharacterWizard.open();
        assert.exists(app, "the creator didn't open for a GM");
        await app.settle();
        if ( app.step === "start" ) {
          app.element.querySelector('[data-action="begin"]')?.click();
          await app.settle();
        }
        await walkWizard(app, { name });
        const select = app.element.querySelector(".cc-owner-pick");
        assert.exists(select, "Review asks a GM who the character is for");
        assert.equal(select.value, "", "keeping it is the default");
        if ( forPlayer ) {
          select.value = forPlayer.id;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          await app.settle();
          assert.deepEqual(Object.keys(app.draft.abilities.base ?? {}).sort(), ["cha", "con", "dex", "int", "str", "wis"],
            "choosing a player leaves the ability scores alone");
        }
        app.element.querySelector('[data-action="create"]').click();
        for ( let i = 0; i < 300 && (app.draft?.status !== "created"); i++ ) await wait(200);
        assert.equal(app.draft.status, "created", JSON.stringify(app.draft.result?.errors ?? []).slice(0, 400));
        // The finished screen is drawn once the create call has fully returned.
        for ( let i = 0; i < 100 && !app.element.querySelector(".cc-outcome--created"); i++ ) await wait(100);
        await app.settle();
        const actor = await fromUuid(app.draft.result.actorUuid);
        assert.exists(actor);
        made.push(actor.id);
        return actor;
      };

      before(async function() {
        this.timeout(120_000);
        assert.isTrue(game.user.isGM, "run on the GM");
        ({ CharacterWizard } = await import("../scripts/wizard/app.mjs"));
        ({ walkWizard } = await import("./wizard.mjs"));
        assign = await import("../scripts/gm/assign.mjs");
        player = (globalThis.ccTestPlayer ? game.users.getName(globalThis.ccTestPlayer) : null)
          ?? game.users.find(u => !u.isGM);
        assert.exists(player, "the world needs a player");
        savedDraft = flag();
        savedCharacter = player.character?.id ?? null;
        savedLimit = game.settings.get(MODULE_ID, "characterLimit");
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        // The player limit is 1 and the GM makes two: it mustn't apply to a GM.
        await game.settings.set(MODULE_ID, "characterLimit", 1);
        await player.update({ character: null });
      });
      afterEach(async function() {
        this.timeout(60_000);
        if ( app?.rendered ) await app.close();
        app = null;
      });
      after(async function() {
        this.timeout(120_000);
        await Actor.deleteDocuments(made.filter(id => game.actors.has(id)));
        await game.settings.set(MODULE_ID, "characterLimit", savedLimit);
        await player.update({ character: savedCharacter && game.actors.has(savedCharacter) ? savedCharacter : null });
        if ( savedDraft === undefined ) await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        else await game.user.update({ [`flags.${MODULE_ID}.${DRAFT_FLAG}`]: foundry.data.operators.ForcedReplacement.create(savedDraft) });
      });

      it("the Actors tab offers a GM the creator", async function() {
        this.timeout(30_000);
        const { refreshEntryPoints } = await import("../scripts/ui/entry-ui.mjs");
        await ui.actors.render({ force: true });
        refreshEntryPoints();
        const button = ui.actors.element.querySelector(".cc-entry--create, .cc-entry--continue");
        assert.exists(button, "no creator button for the GM");
      });

      it("a character made 'for me' stays the GM's, and isn't made the GM's character", async function() {
        this.timeout(600_000);
        const before = game.user.character?.id ?? null;
        const actor = await makeOne("GM Keeper");
        assert.isTrue(actor.testUserPermission(game.user, "OWNER"));
        assert.isFalse(actor.testUserPermission(player, "OBSERVER"), "no player can see it yet");
        assert.equal(game.user.character?.id ?? null, before, "the GM's assigned character is untouched");
        assert.exists(app.element.querySelector('[data-action="give"]'), "the finished screen offers to give it away");
      });

      it("the player limit doesn't apply, and a player chosen at Review gets the character", async function() {
        this.timeout(600_000);
        const actor = await makeOne("GM Gift", player);
        for ( let i = 0; i < 50 && !actor.testUserPermission(player, "OWNER"); i++ ) await wait(100);
        assert.isTrue(actor.testUserPermission(player, "OWNER"), `${player.name} should own it`);
        assert.equal(player.character?.id, actor.id, "a player with no character gets it as theirs");
        assert.include(app.element.querySelector(".cc-outcome").textContent, player.name, "the outcome says who got it");
      });

      it("'Give to a player…' is on a character's context menu, and gives it", async function() {
        this.timeout(120_000);
        const kept = game.actors.getName("GM Keeper");
        assert.exists(kept);
        const options = [];
        Hooks.call("getActorContextOptions", ui.actors, options);
        const give = options.find(o => o.name === game.i18n.localize("CHARCREATOR.Assign.Menu"));
        assert.exists(give, "no 'Give to a player…' entry");
        const li = document.createElement("li");
        li.dataset.entryId = kept.id;
        assert.isTrue(!!(give.visible ?? give.condition)(li), "offered on a character");
        await assign.giveToPlayer(kept, player);
        assert.isTrue(kept.testUserPermission(player, "OWNER"));
        assert.notEqual(player.character?.id, kept.id, "a player who already has a character keeps it");
      });
    });
  }, { displayName: "Character Creator: a GM's own characters" });
}

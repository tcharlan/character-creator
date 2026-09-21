import { MODULE_ID } from "../scripts/main.mjs";
import { SUBMIT_TEST_QUERIES } from "./submit.mjs";

/*
 * "Upload portrait" for a character that already exists (PLAN 4.3, A5), as Player A: the dialog saves through
 * the GM, the sheet's header menu and the Actors context menu offer it for a character the player owns, and
 * neither offers it for one they don't.
 */

const PORTRAIT_ACTOR = `${MODULE_ID}.test.portraitActor`;

export function registerPortraitDialogBatches(quench) {
  quench.registerBatch(`${MODULE_ID}.portrait-dialog@gm`, ({ describe, it, before, after, afterEach, assert }) => {
    describe("Upload portrait after creation, as Player A", () => {
      let PortraitApp;
      let canUploadFor;
      let image;
      let actor;
      let app = null;
      const gm = () => game.users.activeGM;
      const cleanup = () => gm().query(SUBMIT_TEST_QUERIES.CLEANUP, {}, { timeout: 60_000 });

      before(async function() {
        this.timeout(180_000);
        assert.isFalse(game.user.isGM, "run as a player");
        assert.exists(gm(), "no active GM — run with npm run test:foundry");
        ({ PortraitApp } = await import("../scripts/portrait/portrait-app.mjs"));
        ({ canUploadFor } = await import("../scripts/ui/sheet-entry.mjs"));
        const S = await import("./support.mjs");
        const { preparePortrait } = await import("../scripts/portrait/prepare.mjs");
        image = await preparePortrait(await S.makeTestImage(900, 1200));
        await cleanup();
        const uuid = await gm().query(PORTRAIT_ACTOR, { owned: true }, { timeout: 60_000 });
        actor = await fromUuid(uuid);
        assert.exists(actor, "the test character wasn't made");
      });
      afterEach(async function() {
        this.timeout(60_000);
        if ( app?.rendered ) await app.close();
        app = null;
      });
      after(async function() {
        this.timeout(60_000);
        if ( gm() ) await cleanup();
      });

      it("the sheet's header menu and the Actors context menu offer it for your own character", async function() {
        this.timeout(120_000);
        assert.isTrue(canUploadFor(actor), "you own this one");
        const unowned = await fromUuid(await gm().query(SUBMIT_TEST_QUERIES.UNOWNED, {}, { timeout: 60_000 }));
        assert.isFalse(canUploadFor(unowned), "someone else's character is not yours to change");

        actor.sheet.render(true);
        for ( let i = 0; i < 100 && !actor.sheet.rendered; i++ ) await new Promise(r => setTimeout(r, 100));
        const controls = [...actor.sheet._headerControlButtons()];
        const ours = controls.find(c => c.action === `${MODULE_ID}-portrait`);
        assert.exists(ours, "no control in the sheet's header menu");
        assert.equal(ours.label, "CHARCREATOR.Portrait.UploadTitle");
        await actor.sheet.close();

        const options = [];
        Hooks.callAll("getActorContextOptions", ui.actors, options);
        const entry = options.find(o => (o.name ?? o.label) === game.i18n.localize("CHARCREATOR.Portrait.UploadTitle"));
        assert.exists(entry, "no entry in the Actors context menu");
        const li = { dataset: { entryId: actor.id }, closest: () => ({ dataset: { entryId: actor.id } }) };
        assert.isTrue(entry.condition(li));
      });

      it("a picture chosen here is saved on the character by the GM, with the ring colours", async function() {
        this.timeout(180_000);
        const before = actor.img;
        app = await PortraitApp.open(actor);
        assert.exists(app, "the dialog didn't open");
        assert.isFalse(app.element.querySelector('[data-action="save"]').disabled === false,
          "nothing to save before a picture is chosen");

        const { setDialogImage, setDialogRing } = await import("../scripts/portrait/portrait-model.mjs");
        setDialogImage(app.state, image);
        setDialogRing(app.state, "ring", "#4477aa");
        await app.render({ parts: ["body"] });
        assert.exists(app.element.querySelector(".cc-token img"), "the picture isn't previewed");
        assert.isFalse(app.element.querySelector('[data-action="save"]').disabled, "it can be saved now");

        const res = await app.save();
        assert.isTrue(res?.ok, JSON.stringify(res));
        for ( let i = 0; i < 100 && (actor.img === before); i++ ) await new Promise(r => setTimeout(r, 100));
        assert.notEqual(actor.img, before, "the character kept its old picture");
        assert.match(actor.img, new RegExp(`assets/actors/${actor.id}-[^/]+\\.webp$`));
        assert.match(actor.prototypeToken.texture.src, new RegExp(`assets/actors/${actor.id}-token-[^/]+\\.webp$`),
          "the token gets the round cut-out (PLAN 3.11)");
        assert.equal(actor.prototypeToken.ring.colors.ring.css, "#4477aa");
        assert.isFalse(app.rendered, "the dialog closes once it's saved");
      });

      it("a character you don't own can't be given a picture", async function() {
        this.timeout(120_000);
        const unowned = await fromUuid(await gm().query(SUBMIT_TEST_QUERIES.UNOWNED, {}, { timeout: 60_000 }));
        const refused = await PortraitApp.open(unowned);
        assert.isNull(refused, "the dialog should refuse to open");
      });
    });
  }, { displayName: "Character Creator: Upload portrait (after creation)" });
}

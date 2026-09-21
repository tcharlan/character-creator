import { MODULE_ID } from "../scripts/main.mjs";
import { DRAFT_FLAG } from "../scripts/contracts.mjs";
import { SETTINGS_TEST_QUERIES } from "./settings.mjs";

/*
 * Fullscreen or a window, and the backdrop behind each step (D28), as a player with a GM online (the GM sets the
 * background-per-step setting). The player's draft and their display choice are put back afterwards.
 */

const flag = () => game.user.getFlag(MODULE_ID, DRAFT_FLAG);
const raw = value => game.user.update({ [`flags.${MODULE_ID}.${DRAFT_FLAG}`]: foundry.data.operators.ForcedReplacement.create(value) });
const DISPLAY = "wizardDisplay";
const wait = ms => new Promise(r => setTimeout(r, ms));

export function registerDisplayBatches(quench) {
  quench.registerBatch(`${MODULE_ID}.display@gm`, ({ describe, it, before, after, afterEach, assert }) => {
    describe("Fullscreen, window and backdrops (D28), as a player", () => {
      let CharacterWizard;
      let savedDraft;
      let savedDisplay;
      let app = null;
      const gm = () => game.users.activeGM;
      const setWorld = (key, value) => gm().query(SETTINGS_TEST_QUERIES.SET,
        value === null ? { key, reset: true } : { key, value }, { timeout: 60_000 });
      const open = async () => {
        app = await CharacterWizard.open();
        assert.exists(app, "the wizard didn't open");
        await app.settle();
        return app;
      };
      const reopen = async () => {
        await app.close();
        return open();
      };
      const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
      const splash = () => app.element.querySelector(".cc-splash");
      /** Wait for an image to load (or fail): a broken sigil path should fail the test, not hang it. */
      const loaded = img => (img.complete ? Promise.resolve() : new Promise(r => {
        img.addEventListener("load", r, { once: true });
        img.addEventListener("error", r, { once: true });
      }));

      before(async function() {
        this.timeout(120_000);
        assert.isFalse(game.user.isGM, "run as a player");
        assert.exists(gm(), "no active GM — run with npm run test:foundry");
        ({ CharacterWizard } = await import("../scripts/wizard/app.mjs"));
        savedDraft = flag();
        savedDisplay = foundry.utils.deepClone(game.settings.get(MODULE_ID, DISPLAY));
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        await game.settings.set(MODULE_ID, DISPLAY, { mode: "fullscreen", window: null });
      });
      afterEach(async function() {
        this.timeout(60_000);
        if ( app?.rendered ) await app.close();
        app = null;
      });
      after(async function() {
        this.timeout(120_000);
        await setWorld("stepArt", null);
        await game.settings.set(MODULE_ID, DISPLAY, savedDisplay);
        if ( savedDraft === undefined ) await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        else await raw(savedDraft);
      });

      it("opens fullscreen the first time, covering the whole browser window", async function() {
        this.timeout(120_000);
        await open();
        assert.equal(app.displayMode, "fullscreen");
        assert.isTrue(app.element.classList.contains("cc-fullscreen"));
        const box = app.element.getBoundingClientRect();
        assert.deepEqual([box.left, box.top, Math.round(box.width), Math.round(box.height)],
          [0, 0, viewport().width, viewport().height]);
        const control = app.element.querySelector('.window-header [data-action="display"]');
        assert.exists(control, "no fullscreen/window button in the header");
        assert.equal(control.getAttribute("aria-label"), game.i18n.localize("CHARCREATOR.Display.ToWindow"));
      });

      it("fullscreen can't be dragged or resized", async function() {
        this.timeout(120_000);
        await open();
        app.setPosition({ left: 200, top: 150, width: 700, height: 500 });
        const box = app.element.getBoundingClientRect();
        assert.deepEqual([box.left, box.top, Math.round(box.width)], [0, 0, viewport().width]);
      });

      it("switches to a window, remembered with where the player leaves it", async function() {
        this.timeout(120_000);
        await open();
        app.element.querySelector('.window-header [data-action="display"]').click();
        for ( let i = 0; i < 50 && (app.displayMode !== "window"); i++ ) await wait(100);
        assert.equal(app.displayMode, "window");
        assert.isFalse(app.element.classList.contains("cc-fullscreen"));
        assert.isBelow(app.element.getBoundingClientRect().width, viewport().width, "a window, not the whole screen");
        assert.equal(game.settings.get(MODULE_ID, DISPLAY).mode, "window");

        app.setPosition({ left: 40, top: 30, width: 1000, height: 640 });
        for ( let i = 0; i < 30 && (game.settings.get(MODULE_ID, DISPLAY).window?.left !== 40); i++ ) await wait(100);
        assert.deepEqual(game.settings.get(MODULE_ID, DISPLAY).window, { left: 40, top: 30, width: 1000, height: 640 });

        await reopen();
        assert.equal(app.displayMode, "window", "it opens the way it was left");
        const box = app.element.getBoundingClientRect();
        assert.deepEqual([box.left, box.top, Math.round(box.width), Math.round(box.height)], [40, 30, 1000, 640]);
      });

      it("goes back to fullscreen, and that is remembered too", async function() {
        this.timeout(120_000);
        await game.settings.set(MODULE_ID, DISPLAY, { mode: "window", window: { left: 40, top: 30, width: 1000, height: 640 } });
        await open();
        await app.setDisplay("fullscreen");
        assert.equal(Math.round(app.element.getBoundingClientRect().width), viewport().width);
        assert.deepEqual(game.settings.get(MODULE_ID, DISPLAY),
          { mode: "fullscreen", window: { left: 40, top: 30, width: 1000, height: 640 } }, "the window is still remembered");
        await reopen();
        assert.equal(app.displayMode, "fullscreen");
        await app.setDisplay("window");
        const box = app.element.getBoundingClientRect();
        assert.deepEqual([box.left, box.top], [40, 30], "and the window comes back where it was");
      });

      it("minimizing from fullscreen leaves the choice alone, and restoring returns to fullscreen", async function() {
        this.timeout(120_000);
        await game.settings.set(MODULE_ID, DISPLAY, { mode: "fullscreen", window: null });
        await open();
        await app.minimize();
        assert.isTrue(app.minimized);
        assert.equal(game.settings.get(MODULE_ID, DISPLAY).mode, "fullscreen");
        await app.maximize();
        assert.equal(app.displayMode, "fullscreen");
        // Foundry animates the size back.
        const width = () => Math.round(app.element.getBoundingClientRect().width);
        for ( let i = 0; i < 40 && (width() !== viewport().width); i++ ) await wait(100);
        assert.equal(width(), viewport().width);
      });

      it("each step has its own sigil behind it, and it loads", async function() {
        this.timeout(120_000);
        await open();
        const seen = [];
        // A fresh draft: whichever of these open before anything is picked.
        for ( const wanted of ["start", "species", "class", "background", "abilities"] ) {
          await app.goTo(wanted);
          await app.settle();
          const step = app.step;
          if ( seen.includes(step) ) continue;
          const sigil = splash()?.querySelector(".cc-splash__sigil");
          assert.exists(sigil, `no sigil on ${step}`);
          assert.equal(splash().dataset.splash, step);
          assert.isTrue(sigil.getAttribute("src").endsWith(`assets/splash/${step}.svg`), `${step}: ${sigil.getAttribute("src")}`);
          await loaded(sigil);
          assert.isAbove(sigil.naturalWidth, 0, `the ${step} sigil didn't load`);
          assert.equal(getComputedStyle(splash()).pointerEvents, "none", "the backdrop never takes a click");
          seen.push(step);
        }
        assert.isAtLeast(seen.length, 2);
      });

      it("the picked option's picture sits behind its step", async function() {
        this.timeout(180_000);
        await open();
        await app.goTo("species");
        await app.settle();
        app.element.querySelector('[data-action="pick"]').click();
        for ( let i = 0; i < 100 && !app.draft.picks.species; i++ ) await wait(100);
        await app.settle();
        const art = splash().querySelector(".cc-splash__art");
        const { getCatalog } = await import("../scripts/catalog/catalog.mjs");
        const img = (await getCatalog()).get(app.draft.picks.species)?.img;
        if ( !img || img.startsWith("icons/svg/") ) return this.skip();
        assert.exists(art, "the species' picture should be behind the species step");
        assert.equal(art.getAttribute("src"), img);
        assert.exists(splash().querySelector(".cc-splash__sigil"), "with the sigil over it");
      });

      it("the GM's own background replaces the sigil on that step only", async function() {
        this.timeout(180_000);
        await setWorld("stepArt", { species: "icons/svg/mystery-man.svg" });
        for ( let i = 0; i < 50 && !game.settings.get(MODULE_ID, "stepArt")?.species; i++ ) await wait(100);
        await open();
        await app.goTo("species");
        await app.settle();
        assert.isTrue(splash().classList.contains("cc-splash--gm"));
        assert.equal(splash().querySelector(".cc-splash__art")?.getAttribute("src"), "icons/svg/mystery-man.svg");
        assert.notExists(splash().querySelector(".cc-splash__sigil"));
        await app.goTo("background");
        await app.settle();
        assert.isFalse(splash().classList.contains("cc-splash--gm"), "other steps keep their sigil");
        assert.exists(splash().querySelector(".cc-splash__sigil"));
      });
    });
  });
}

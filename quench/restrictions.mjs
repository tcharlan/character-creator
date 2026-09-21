import { MODULE_ID } from "../scripts/main.mjs";
import { SETTINGS_TEST_QUERIES } from "./settings.mjs";

/*
 * The GM's allowed-content screen (PLAN 4.1): it lists what this world could offer, a click narrows a
 * category, saving writes the settings the catalog reads, and the wizard follows. Runs on the GM.
 */

export function registerRestrictionsBatches(quench) {
  quench.registerBatch(`${MODULE_ID}.restrictions@gmpage`, ({ describe, it, before, after, afterEach, assert }) => {
    describe("Allowed content (scripts/settings), on the GM", () => {
      let RestrictionsApp;
      let app = null;
      const reset = async () => {
        for ( const key of ["restrictions", "abilityMethods"] ) {
          await CONFIG.queries[SETTINGS_TEST_QUERIES.SET]({ key, reset: true }, { user: game.user });
        }
      };
      const el = () => app.element;
      const entries = () => [...el().querySelectorAll('[data-action="entry"]')];

      before(async function() {
        this.timeout(180_000);
        assert.isTrue(game.user.isGM, "this screen is the GM's");
        ({ RestrictionsApp } = await import("../scripts/settings/restrictions-app.mjs"));
        await reset();
      });
      afterEach(async function() {
        this.timeout(60_000);
        if ( app?.rendered ) await app.close();
        app = null;
        await reset();
      });
      after(async function() {
        this.timeout(60_000);
        await reset();
      });

      it("is in Foundry's own settings window, for GMs only", () => {
        const menu = game.settings.menus.get(`${MODULE_ID}.restrictionsMenu`);
        assert.exists(menu, "no settings menu is registered");
        assert.isTrue(menu.restricted, "players should not be offered it");
        assert.equal(menu.name, "CHARCREATOR.Restrictions.MenuName");
      });

      it("lists everything this world could offer, whatever is allowed today", async function() {
        this.timeout(180_000);
        const { getCatalog } = await import("../scripts/catalog/catalog.mjs");
        const { NO_RESTRICTIONS } = await import("../scripts/catalog/filters.mjs");
        const everything = await getCatalog({ restrictions: NO_RESTRICTIONS });
        app = await RestrictionsApp.open();
        assert.exists(app, "the screen didn't open");
        await app.show("class");
        assert.equal(entries().length, everything.byCategory.class.length, "every class in the world is listed");
        assert.isAbove(entries().length, 1);
        assert.isTrue(entries().every(e => e.getAttribute("aria-pressed") === "true"), "all allowed to start with");
      });

      it("a class turned off is saved, and disappears from the player's catalog", async function() {
        this.timeout(300_000);
        const { getCatalog, invalidateCatalog } = await import("../scripts/catalog/catalog.mjs");
        const player = game.users.find(u => !u.isGM && u.active) ?? game.users.find(u => !u.isGM);
        app = await RestrictionsApp.open();
        await app.show("class");
        const dropped = entries()[1];
        const uuid = dropped.dataset.uuid;
        const name = dropped.querySelector(".cc-entry__name").textContent.trim();
        dropped.click();
        await new Promise(r => setTimeout(r, 200));
        assert.deepEqual(app.state.categories.class.includes(uuid), false, "the state dropped it");
        el().querySelector('[data-action="save"]').click();
        for ( let i = 0; i < 200 && app.rendered; i++ ) await new Promise(r => setTimeout(r, 100));

        const stored = game.settings.get(MODULE_ID, "restrictions");
        assert.isArray(stored.categories.class);
        assert.notInclude(stored.categories.class, uuid, `${name} should not be in the stored list`);
        invalidateCatalog("test");
        const catalog = await getCatalog({ user: player });
        assert.notInclude(catalog.byCategory.class.map(e => e.name), name, "the player is not offered it any more");
        assert.isFalse(catalog.isAllowed(uuid), "and the validator would refuse it");
      });

      it("warns when a category is left empty or down to one, and when one method is left", async function() {
        this.timeout(180_000);
        const { allowNone, allowOnly, toggleMethod, warnings } = await import("../scripts/settings/restrictions-model.mjs");
        app = await RestrictionsApp.open();
        await app.show("class");
        const first = entries()[0].dataset.uuid;

        await app.change(state => allowNone(state, "class"));
        const empty = el().querySelector(".cc-restrict__warnings").textContent;
        assert.include(empty.toLowerCase(), "nobody can make a character");
        assert.deepEqual(warnings(app.state, app.everything).filter(w => w.category === "class").map(w => w.key),
          ["NoneRequired"]);

        await app.change(state => allowOnly(state, "class", [first]));
        assert.deepEqual(warnings(app.state, app.everything).filter(w => w.category === "class").map(w => w.key),
          ["OnlyOne"]);

        await app.show("abilities");
        await app.change(state => toggleMethod(toggleMethod(state, "rolled"), "pointBuy"));
        assert.deepEqual(app.state.abilityMethods, ["standardArray"]);
        const last = [...el().querySelectorAll('[data-action="method"]')].find(b => b.dataset.method === "standardArray");
        assert.isTrue(last.disabled, "the only method left can't be turned off");
        assert.include(el().querySelector(".cc-restrict__warnings").textContent.toLowerCase(), "one way");
      });

      it("leaving one class makes the wizard choose it (D4), and saving one method makes it automatic", async function() {
        this.timeout(300_000);
        const { allowOnly, toggleMethod } = await import("../scripts/settings/restrictions-model.mjs");
        const { invalidateCatalog, getCatalog } = await import("../scripts/catalog/catalog.mjs");
        app = await RestrictionsApp.open();
        await app.show("class");
        const only = entries()[0].dataset.uuid;
        await app.change(state => {
          allowOnly(state, "class", [only]);
          return toggleMethod(toggleMethod(state, "rolled"), "pointBuy");
        });
        await app.save();
        for ( let i = 0; i < 200 && app.rendered; i++ ) await new Promise(r => setTimeout(r, 100));

        const { readSettings } = await import("../scripts/settings/settings.mjs");
        assert.deepEqual(readSettings().abilityMethods, ["standardArray"]);
        invalidateCatalog("test");
        const catalog = await getCatalog();
        assert.lengthOf(catalog.byCategory.class, 1, "one class left");
        assert.equal(catalog.get(only)?.uuid !== undefined || catalog.isAllowed(only), true);
      });
    });
  }, { displayName: "Character Creator: Allowed content (GM)" });
}

import { MODULE_ID } from "../scripts/main.mjs";
import { QUERIES } from "../scripts/contracts.mjs";
import { SUBMIT_TEST_QUERIES } from "./submit.mjs";
import { ABILITY_TEST_QUERIES } from "./abilities.mjs";
import { legitDraft } from "./validator.mjs";

/*
 * Settings (PLAN 2.10): registered with their defaults, and each one followed by what reads it — the catalog
 * (restrictions), the validator (ability methods), submit (limit, folder, uploads, ring defaults) and portrait
 * preparation (upload size). The GM changes settings through a test query; everything is restored after.
 */

const FIXED = {
  legacy: { species: "High Elf", background: "Acolyte", class: "Wizard" },
  modern: { species: "Human", background: "Sage", class: "Cleric" }
};
const Q = {
  SET: `${MODULE_ID}.test.setSetting`,
  DELETE_FOLDER: `${MODULE_ID}.test.deleteFolder`
};
const TEST_FOLDER = "Character Creator test folder";

export function registerSettingsTestQueries() {
  const gmOnly = () => {
    if ( !game.user.isGM || !game.users.activeGM?.isSelf ) throw new Error("Only the active GM");
  };
  // Set one of this module's settings; returns the previous stored value (undefined = default).
  CONFIG.queries[Q.SET] = async ({ key, value, reset = false }) => {
    gmOnly();
    const full = `${MODULE_ID}.${key}`;
    const stored = game.settings.storage.get("world").find(s => s.key === full);
    const before = stored ? foundry.utils.deepClone(stored.value) : undefined;
    if ( reset ) {
      if ( stored ) await stored.delete();
    } else await game.settings.set(MODULE_ID, key, value);
    return { before };
  };
  CONFIG.queries[Q.DELETE_FOLDER] = async ({ name }) => {
    gmOnly();
    const ids = game.folders.filter(f => f.type === "Actor" && f.name === name).map(f => f.id);
    await foundry.utils.getDocumentClass("Folder").deleteDocuments(ids);
    return ids.length;
  };
}

export function registerSettingsBatches(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.settings@gm`, ({ describe, it, before, after, afterEach, assert }) => {
    describe("Settings: registered, and followed by what reads them", () => {
      let catalog;
      let image;
      const touched = new Set();
      const draftIds = [];
      const gm = () => game.users.activeGM;
      const query = (name, data) => gm().query(name, data, { timeout: 120_000 });
      const set = async (key, value) => {
        touched.add(key);
        await query(Q.SET, { key, value });
        // The change reaches this client through the setting's update; wait for it.
        for ( let i = 0; i < 40 && JSON.stringify(game.settings.get(MODULE_ID, key)) !== JSON.stringify(value); i++ ) {
          await new Promise(r => setTimeout(r, 100));
        }
      };
      const submit = payload => query(QUERIES.SUBMIT, payload);
      const draft = async (over = {}) => {
        const C = await import("../scripts/catalog/catalog.mjs");
        const d = await legitDraft({ ...FIXED[rules()], ...over }, { catalog: catalog ?? await C.getCatalog() });
        draftIds.push(d.id);
        return d;
      };
      const cleanup = () => query(SUBMIT_TEST_QUERIES.CLEANUP, {});

      before(async function() {
        this.timeout(120_000);
        assert.isFalse(game.user.isGM, "run as a player");
        assert.exists(gm(), "no active GM — run with npm run test:foundry");
        await cleanup();
        const S = await import("./support.mjs");
        const { preparePortrait } = await import("../scripts/portrait/prepare.mjs");
        image = await preparePortrait(await S.makeTestImage(600, 600));
      });
      afterEach(async function() {
        this.timeout(60_000);
        await cleanup();
      });
      after(async function() {
        this.timeout(120_000);
        if ( !gm() ) return;
        for ( const key of touched ) await query(Q.SET, { key, reset: true });
        await cleanup();
        await query(Q.DELETE_FOLDER, { name: TEST_FOLDER });
        await query(ABILITY_TEST_QUERIES.CLEANUP, { draftIds });
      });

      it("every setting is registered as a world setting, with the documented defaults", async () => {
        const { SETTINGS } = await import("../scripts/settings/normalize.mjs");
        for ( const key of Object.values(SETTINGS) ) {
          const cfg = game.settings.settings.get(`${MODULE_ID}.${key}`);
          assert.exists(cfg, key);
          assert.equal(cfg.scope, "world", key);
        }
        const { readSettings } = await import("../scripts/settings/settings.mjs");
        const s = readSettings();
        assert.equal(s.characterLimit, 1);
        assert.equal(s.folderName, "Player Characters");
        assert.deepEqual(s.abilityMethods, ["pointBuy", "standardArray", "rolled"]);
      });
      it("restrictions: a class the GM leaves out disappears from the player's catalog and is refused", async function() {
        this.timeout(120_000);
        const C = await import("../scripts/catalog/catalog.mjs");
        catalog = await C.getCatalog();
        const d = await draft();
        const keep = catalog.byCategory.class.filter(e => e.name !== FIXED[rules()].class).map(e => e.uuid);
        await set("restrictions", { packs: null, categories: { class: keep } });
        const narrowed = await C.getCatalog();
        assert.notInclude(narrowed.byCategory.class.map(e => e.name), FIXED[rules()].class);
        const res = await submit({ draft: d });
        assert.include(res.errors.map(e => e.code), "CLASS_NOT_ALLOWED");
        await query(Q.SET, { key: "restrictions", reset: true });
        for ( let i = 0; i < 40 && game.settings.get(MODULE_ID, "restrictions").categories?.class; i++ ) await new Promise(r => setTimeout(r, 100));
        assert.include((await C.getCatalog()).byCategory.class.map(e => e.name), FIXED[rules()].class, "back after reset");
      });
      it("ability methods: a method the GM doesn't allow is refused", async function() {
        this.timeout(120_000);
        await set("abilityMethods", ["pointBuy"]);
        const res = await submit({ draft: await draft() });
        assert.deepEqual(res.errors.map(e => e.code), ["ABILITY_METHOD_NOT_ALLOWED"]);
        await set("abilityMethods", ["pointBuy", "standardArray", "rolled"]);
      });
      it("folder: new characters go into the folder, created if missing", async function() {
        this.timeout(120_000);
        await set("folderName", TEST_FOLDER);
        const res = await submit({ draft: await draft() });
        assert.isTrue(res.ok, JSON.stringify(res.errors ?? []).slice(0, 300));
        const actor = await fromUuid(res.actorUuid);
        assert.equal(actor.folder?.name, TEST_FOLDER);
        assert.lengthOf(game.folders.filter(f => f.type === "Actor" && f.name === TEST_FOLDER), 1);
      });
      it("uploads off: the character is created without the portrait (warning); later uploads and preparation refuse", async function() {
        this.timeout(120_000);
        await set("allowPortraitUploads", false);
        const res = await submit({ draft: await draft(), image });
        assert.isTrue(res.ok);
        assert.deepEqual(res.warnings.map(e => e.code), ["UPLOADS_DISABLED"]);
        const actor = await fromUuid(res.actorUuid);
        assert.notInclude(actor.img, "assets/actors");
        const up = await query(QUERIES.UPLOAD_PORTRAIT, { actorUuid: actor.uuid, image });
        assert.deepEqual(up.errors.map(e => e.code), ["UPLOADS_DISABLED"]);
        const { preparePortrait } = await import("../scripts/portrait/prepare.mjs");
        const S = await import("./support.mjs");
        const err = await preparePortrait(await S.makeTestImage(100, 100)).catch(e => e);
        assert.equal(err?.error?.code, "UPLOADS_DISABLED");
        await set("allowPortraitUploads", true);
      });
      it("upload size: a file over the GM's limit is refused before resizing", async function() {
        this.timeout(120_000);
        await set("maxUploadMB", 1);
        const S = await import("./support.mjs");
        const big = await S.makeTestImage(1400, 1400, { noise: true });
        assert.isAbove(big.size, 1024 * 1024);
        const { preparePortrait } = await import("../scripts/portrait/prepare.mjs");
        const err = await preparePortrait(big).catch(e => e);
        assert.equal(err?.error?.code, "IMAGE_TOO_LARGE");
        await set("maxUploadMB", 10);
      });
      it("ring defaults: used when the player chooses no ring colors", async function() {
        this.timeout(120_000);
        await set("ringColors", { ring: "#123456", background: "#654321" });
        const d = await draft();
        d.portrait.ring = { ring: null, background: null, effects: 1 };
        const res = await submit({ draft: d, image });
        assert.isTrue(res.ok);
        const actor = await fromUuid(res.actorUuid);
        assert.equal(actor.prototypeToken.ring.colors.ring.css, "#123456");
        assert.equal(actor.prototypeToken.ring.colors.background.css, "#654321");
      });
      it("character limit: 2 allows a second character and refuses a third; 0 means no limit", async function() {
        this.timeout(240_000);
        await set("characterLimit", 2);
        assert.isTrue((await submit({ draft: await draft() })).ok);
        assert.isTrue((await submit({ draft: await draft() })).ok);
        assert.deepEqual((await submit({ draft: await draft() })).errors.map(e => e.code), ["CHARACTER_LIMIT"]);
        await set("characterLimit", 0);
        assert.isTrue((await submit({ draft: await draft() })).ok);
      });
    });
  }, { displayName: "Character Creator: Settings" });
}

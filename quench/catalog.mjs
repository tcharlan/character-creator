import { MODULE_ID } from "../scripts/main.mjs";

/** Test-only GM query: set dnd5e's pack source filter (restores are sent the same way). */
export const SET_PACK_SOURCE = `${MODULE_ID}.test.setPackSource`;

export function registerCatalogTestQueries() {
  CONFIG.queries[SET_PACK_SOURCE] = async ({ value }) => {
    if ( !game.user.isGM || !game.users.activeGM?.isSelf ) throw new Error("Only the active GM");
    const before = foundry.utils.deepClone(game.settings.get("dnd5e", "packSourceConfiguration") ?? {});
    await game.settings.set("dnd5e", "packSourceConfiguration", value);
    return { before };
  };
}

/** SRD counts per rule set (Phase 1: spikes 1.6–1.9). */
const SRD = {
  legacy: { class: 12, species: 9, background: 1, subclass: 12, edition: "2014" },
  modern: { class: 12, species: 14, background: 4, subclass: 12, edition: "2024" }
};
/** A pack to disable per world in the source-filter test, and the category it empties. */
const FLIP = { legacy: ["dnd5e.backgrounds", "background"], modern: ["dnd5e.origins24", "background"] };

export function registerCatalogBatches(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.catalog`, ({ describe, it, before, assert }) => {
    describe("Catalog (PLAN 2.2) on the SRD packs, as Player A", () => {
      let C;
      let cat;
      before(async function() {
        this.timeout(120_000);
        C = await import("../scripts/catalog/catalog.mjs");
        C.invalidateCatalog("test start");
        cat = await C.getCatalog();
        console.log(`${MODULE_ID} | catalog (${rules()}): ${JSON.stringify({ stats: cat.stats, excluded: cat.excluded,
          counts: Object.fromEntries(Object.entries(cat.byCategory).map(([k, v]) => [k, v.length])) })}`);
      });

      it("holds exactly the SRD classes, subclasses, species and backgrounds of this rule set", () => {
        const s = SRD[rules()];
        for ( const k of ["class", "subclass", "species", "background"] ) assert.equal(cat.byCategory[k].length, s[k], k);
      });
      it("nothing from the other rule set is offered", () => {
        const edition = SRD[rules()].edition;
        const leaks = [...cat.allowed.values()].filter(e => e.system?.source?.rules && e.system.source.rules !== edition);
        assert.deepEqual(leaks.map(e => e.name).slice(0, 10), []);
      });
      it("no monster features, and every category has entries", () => {
        assert.deepEqual(cat.byCategory.feat.filter(e => e.system?.type?.value === "monster").map(e => e.name), []);
        for ( const [k, v] of Object.entries(cat.byCategory) ) assert.isAbove(v.length, 0, k);
      });
      it("items referenced by allowed content are allowed across rules (2024 Soldier's 2014 clothes)", function() {
        if ( rules() !== "modern" ) this.skip();
        const clothes = "Compendium.dnd5e.items.Item.SsAmWV6YBqeOFihT";
        assert.notExists(cat.get(clothes), "not offered on its own (2014 item)");
        assert.isTrue(cat.isAllowed(clothes), "allowed as the Soldier's kit");
      });
      it("every fixed reference of allowed species, classes and backgrounds is usable", async () => {
        const { fixedReferences } = await import("../scripts/catalog/filters.mjs");
        const roots = [...cat.byCategory.species, ...cat.byCategory.class, ...cat.byCategory.background];
        const missing = roots.flatMap(r => fixedReferences(r).filter(u => !cat.isAllowed(u)).map(u => `${r.name}: ${u}`));
        assert.deepEqual(missing, []);
      });
      it("GM restrictions narrow it: one class; no species (and a shortfall)", async () => {
        const fighter = cat.byCategory.class.find(e => e.name === "Fighter");
        const narrowed = await C.getCatalog({ restrictions: { packs: null, categories: { class: [fighter.uuid], species: [] } } });
        assert.deepEqual(narrowed.byCategory.class.map(e => e.name), ["Fighter"]);
        assert.lengthOf(narrowed.byCategory.species, 0);
        const speciesOptions = cat.byCategory.species.map(e => e.uuid);
        assert.isTrue(narrowed.shortfall(speciesOptions, 1).short);
        assert.isFalse(cat.shortfall(speciesOptions, 1).short);
      });
      it("a pool the GM narrows to exactly the picks needed is 'exact' (auto-select, D4)", async function() {
        if ( rules() !== "modern" ) this.skip();
        const fighter = await fromUuid(cat.byCategory.class.find(e => e.name === "Fighter").uuid);
        const style = fighter.advancement.byType.ItemChoice.find(a => a.title === "Fighting Style");
        const pool = style.configuration.pool.map(p => p.uuid);
        const feats = cat.byCategory.feat.filter(e => !pool.slice(1).includes(e.uuid)).map(e => e.uuid);
        const narrowed = await C.getCatalog({ restrictions: { packs: null, categories: { feat: feats } } });
        assert.deepEqual(narrowed.shortfall(pool, 1), { available: [pool[0]].map(u => u.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.")),
          needed: 1, short: false, exact: true });
      });
      it("is cached, and rebuilt after invalidation", async () => {
        assert.strictEqual(await C.getCatalog(), cat);
        C.invalidateCatalog("test");
        const fresh = await C.getCatalog();
        assert.notStrictEqual(fresh, cat);
        assert.equal(fresh.allowed.size, cat.allowed.size);
      });
    });
  }, { displayName: "Character Creator: Catalog" });

  quench.registerBatch(`${MODULE_ID}.catalog@gm`, ({ describe, it, after, assert }) => {
    describe("Catalog follows dnd5e's source filter (GM changes it; the player's catalog rebuilds)", () => {
      let original;
      const query = data => game.users.activeGM.query(SET_PACK_SOURCE, data, { timeout: 30_000 });
      after(async function() {
        this.timeout(30_000);
        if ( original !== undefined && game.users.activeGM ) await query({ value: original });
      });

      it("disabling a pack removes its entries; restoring brings them back", async function() {
        this.timeout(120_000);
        const C = await import("../scripts/catalog/catalog.mjs");
        const [packId, category] = FLIP[rules()];
        const before = await C.getCatalog();
        const had = before.byCategory[category].filter(e => e.pack === packId).length;
        assert.isAbove(had, 0);

        const gen = C.catalogGeneration();
        const current = foundry.utils.deepClone(game.settings.get("dnd5e", "packSourceConfiguration") ?? {});
        ({ before: original } = await query({ value: { ...current, [packId]: false } }));
        const waitGen = async () => {
          for ( let i = 0; i < 100 && C.catalogGeneration() === gen; i++ ) await new Promise(r => setTimeout(r, 100));
        };
        await waitGen();
        assert.isAbove(C.catalogGeneration(), gen, "the player's catalog was not invalidated");
        const off = await C.getCatalog();
        assert.equal(off.byCategory[category].filter(e => e.pack === packId).length, 0);
        assert.isAbove(off.excluded.sourceDisabled ?? 0, -1);

        const gen2 = C.catalogGeneration();
        await query({ value: original });
        original = undefined;
        for ( let i = 0; i < 100 && C.catalogGeneration() === gen2; i++ ) await new Promise(r => setTimeout(r, 100));
        const back = await C.getCatalog();
        assert.equal(back.byCategory[category].filter(e => e.pack === packId).length, had);
      });
    });
  }, { displayName: "Character Creator: Catalog (needs GM)" });
}

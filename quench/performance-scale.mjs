import { MODULE_ID } from "../scripts/main.mjs";

/*
 * The wizard on a world the size of one with the full Player's Handbook (PLAN 5.4). The official books aren't in
 * the test worlds, so this makes a world compendium with the SRD's spells and equipment twice over — about as
 * many entries again as a PHB module brings — reads the catalog cold, opens the wizard, and deletes it all.
 * Runs on the GM, whose browser can make a compendium.
 */

// Not named after the module: Foundry reports on a pack by name, and the runner counts anything naming the
// module as the module's error.
const PACK = "cc-scale-test";
const COPIES = 2;
const OPEN_BUDGET_MS = 1000;

export function registerPerformanceScaleBatches(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.heavy.performance-scale@gmpage`, ({ describe, it, before, after, assert }) => {
    describe("Performance on a world with the full books' worth of content (PLAN 5.4), on the GM", () => {
      let C;
      let CharacterWizard;
      let added = 0;
      const collection = `world.${PACK}`;
      const numbers = {};

      before(async function() {
        this.timeout(600_000);
        assert.isTrue(game.user.isGM, "only a GM can make a compendium");
        C = await import("../scripts/catalog/catalog.mjs");
        ({ CharacterWizard } = await import("../scripts/wizard/app.mjs"));
        const existing = game.packs.get(collection);
        if ( existing ) await existing.deleteCompendium();
        await foundry.documents.collections.CompendiumCollection.createCompendium({
          label: "Character Creator scale test", name: PACK, type: "Item", package: "world"
        });

        // The rules version's own spells and equipment, copied under new names.
        const before = (await C.getCatalog()).stats.entries;
        const sources = game.packs.filter(p => (p.documentName === "Item") && (p.metadata.packageName === "dnd5e")
          && /^(spells|items|spells24|equipment24)$/.test(p.metadata.name));
        const Item = foundry.utils.getDocumentClass("Item");
        for ( const pack of sources ) {
          const docs = await pack.getDocuments();
          for ( let copy = 1; copy <= COPIES; copy++ ) {
            const data = docs.map(d => {
              const o = d.toObject();
              delete o._id;
              o.name = `${o.name} (scale ${copy})`;
              return o;
            });
            for ( let i = 0; i < data.length; i += 250 ) {
              added += (await Item.createDocuments(data.slice(i, i + 250), { pack: collection })).length;
            }
          }
        }
        numbers.entriesBefore = before;
        numbers.added = added;
      });

      after(async function() {
        this.timeout(300_000);
        const made = game.packs.get(collection);
        if ( made ) await made.deleteCompendium();
        C.invalidateCatalog("scale test");
        console.log(`${MODULE_ID} | performance at scale (${rules()}): ${JSON.stringify(numbers)}`);
      });

      it("reads a book's worth more content quickly", async function() {
        this.timeout(120_000);
        assert.isAbove(added, 1000, "the test world should really be bigger");
        C.invalidateCatalog("scale test");
        const t0 = performance.now();
        const catalog = await C.getCatalog();
        numbers.catalogCold = Math.round(performance.now() - t0);
        numbers.entries = catalog.stats.entries;
        assert.isAtLeast(catalog.stats.entries, numbers.entriesBefore + added);
        assert.isBelow(numbers.catalogCold, OPEN_BUDGET_MS, "reading every index should take well under a second");
      });

      it(`opens the wizard in under ${OPEN_BUDGET_MS} ms, with the catalog read cold`, async function() {
        this.timeout(120_000);
        const { DRAFT_FLAG } = await import("../scripts/contracts.mjs");
        const saved = game.user.getFlag(MODULE_ID, DRAFT_FLAG);
        await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
        C.invalidateCatalog("scale test");
        try {
          const t0 = performance.now();
          const app = await CharacterWizard.open();
          numbers.openCold = Math.round(performance.now() - t0);
          assert.exists(app);
          await app.close();
          assert.isBelow(numbers.openCold, OPEN_BUDGET_MS);
        } finally {
          if ( saved === undefined ) await game.user.unsetFlag(MODULE_ID, DRAFT_FLAG);
          else await game.user.setFlag(MODULE_ID, DRAFT_FLAG, saved);
        }
      });
    });
  }, { displayName: "Character Creator: Performance at scale (GM)" });
}

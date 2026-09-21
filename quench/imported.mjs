import { MODULE_ID } from "../scripts/main.mjs";

/*
 * Content from somewhere other than dnd5e's own compendiums (PLAN 5.1): an importer's or a homebrewer's items,
 * which may have no edition on them, no advancements at all, or an advancement this module has never heard of.
 * The batch makes a small world compendium of exactly those cases, checks what the creator does with them, and
 * deletes it again. Runs on the GM, whose browser is the one that can make a compendium.
 */

// Not named after the module, for the same reason as the scale test's pack.
const PACK = "cc-import-test";
const NAMES = Object.freeze({
  copied: "Imported Champion",     // an SRD class with the edition stripped off
  bare: "Bare Class",              // no advancements at all
  odd: "Odd Species",              // an advancement type nothing knows
  plain: "Plain Background"        // no starting equipment, no advancements
});

export function registerImportedBatches(quench) {
  quench.registerBatch(`${MODULE_ID}.imported@gmpage`, ({ describe, it, before, after, assert }) => {
    describe("Imported and homebrew content (PLAN 5.1), on the GM", () => {
      let catalog;
      let B;
      let uuids = {};
      const collection = `world.${PACK}`;
      const byName = (list, name) => list.find(e => e.name === name);

      before(async function() {
        this.timeout(300_000);
        assert.isTrue(game.user.isGM, "only a GM can make a compendium");
        B = await import("../scripts/rules/build.mjs");
        const C = await import("../scripts/catalog/catalog.mjs");
        const existing = game.packs.get(collection);
        if ( existing ) await existing.deleteCompendium();
        await foundry.documents.collections.CompendiumCollection.createCompendium({
          label: "Character Creator import test", name: PACK, type: "Item", package: "world"
        });

        // A real class, with nothing saying which edition it belongs to (D11: it follows the world).
        const source = await fromUuid((await C.getCatalog()).byCategory.class[0].uuid);
        const copied = source.toObject();
        delete copied._id;
        copied.name = NAMES.copied;
        foundry.utils.setProperty(copied, "system.source", {});
        foundry.utils.setProperty(copied, "system.identifier", "imported-champion");

        const made = await foundry.utils.getDocumentClass("Item").createDocuments([
          copied,
          { name: NAMES.bare, type: "class", system: { identifier: "bare", hitDice: "d8" } },
          { name: NAMES.odd, type: "race", system: { advancement: [
            { _id: "ZZZZZZZZZZZZZZZZ", type: "Nonsense", title: "Something New", level: 0, configuration: {} }] } },
          { name: NAMES.plain, type: "background" }
        ], { pack: collection });
        uuids = Object.fromEntries(made.map(i => [Object.entries(NAMES).find(([, n]) => n === i.name)[0], i.uuid]));
        C.invalidateCatalog("imported test");
        catalog = await C.getCatalog();
      });

      after(async function() {
        this.timeout(120_000);
        const made = game.packs.get(collection);
        if ( made ) await made.deleteCompendium();
        (await import("../scripts/catalog/catalog.mjs")).invalidateCatalog("imported test");
      });

      it("offers content with no edition on it, in whichever world it is (D11)", function() {
        this.timeout(60_000);
        assert.exists(byName(catalog.byCategory.class, NAMES.copied), "a class with no edition should be offered");
        assert.exists(byName(catalog.byCategory.class, NAMES.bare));
        assert.exists(byName(catalog.byCategory.species, NAMES.odd));
        assert.exists(byName(catalog.byCategory.background, NAMES.plain));
        assert.isTrue(catalog.isAllowed(uuids.copied));
      });

      it("builds a character from imported content without complaint", async function() {
        this.timeout(180_000);
        const built = await B.buildCharacter({ picks: { species: uuids.plainSpecies ?? uuids.odd, class: uuids.copied,
          background: uuids.plain }, base: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, steps: [] },
        { catalog, fill: true, withOptions: true });
        assert.exists(built.actor);
        const fromClass = built.results.filter(r => r.item === NAMES.copied);
        assert.isAbove(fromClass.length, 0, "the copied class keeps its advancements");
        assert.deepEqual(built.errors.filter(e => e.code !== "UNKNOWN_ADVANCEMENT_TYPE"), [],
          "nothing but the homebrew advancement should complain");
      });

      it("an advancement type dnd5e itself doesn't know never reaches the creator", async function() {
        this.timeout(180_000);
        // dnd5e drops an advancement whose type isn't in CONFIG.DND5E.advancementTypes when the item is
        // created, so a homebrewer's own advancement simply isn't there (RESEARCH.md). The creator's own
        // guard is for a type dnd5e knows and this module does not — a future dnd5e (D20).
        const odd = await fromUuid(uuids.odd);
        assert.isEmpty(Object.keys(odd.advancement?.byId ?? {}), "dnd5e kept the unknown advancement");
        const built = await B.buildCharacter({ picks: { species: uuids.odd, class: uuids.bare,
          background: uuids.plain }, base: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, steps: [] },
        { catalog, fill: true, withOptions: true });
        assert.isEmpty(built.results.filter(r => r.item === NAMES.odd), "nothing to answer for that species");
        assert.deepEqual(built.errors, [], "and nothing to complain about");
      });

      it("a homebrew class comes with dnd5e's own advancements, and the creator uses them", async function() {
        this.timeout(180_000);
        const built = await B.buildCharacter({ picks: { species: uuids.odd, class: uuids.bare,
          background: uuids.plain }, base: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, steps: [] },
        { catalog, fill: true, withOptions: true });
        const fromClass = built.results.filter(r => r.item === NAMES.bare);
        assert.deepEqual(fromClass.map(r => r.type), ["HitPoints"], "only level 1 matters here");
        assert.equal(fromClass[0].status, "auto", "hit points are worked out, not asked");
        assert.isAbove(built.actor.system.attributes.hp.max, 0, "a character with hit points");
      });

      it("a background with no starting equipment leaves nothing to decide", async function() {
        this.timeout(180_000);
        const built = await B.buildCharacter({ picks: { species: uuids.odd, class: uuids.bare,
          background: uuids.plain }, base: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, steps: [] },
        { catalog, fill: true, withOptions: true });
        const EQ = await import("../scripts/rules/equipment-items.mjs");
        const { sourceModel } = await import("../scripts/wizard/equipment-step.mjs");
        for ( const role of ["class", "background"] ) {
          const item = built.actor.items.get(built.roots[role]);
          const ctx = await EQ.equipmentContext(built.actor, item, catalog);
          const model = sourceModel({ role, name: item.name, tree: ctx.tree, wealthOption: ctx.wealthOption,
            candidates: ctx.candidates, isProficient: ctx.isProficient }, null, catalog);
          assert.isEmpty(model.decisions, `${role}: nothing to decide`);
          assert.isTrue(model.complete, `${role}: an empty kit is a finished kit`);
        }
      });

      it("a whole character made only of imported content passes the validator", async function() {
        this.timeout(300_000);
        const S = await import("./support.mjs");
        const { createDraft } = await import("../scripts/contracts.mjs");
        const { validateDraft } = await import("../scripts/rules/validate.mjs");
        const { spellContext } = await import("../scripts/rules/spell-facts.mjs");
        const base = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };
        const picks = { species: uuids.odd, class: uuids.copied, background: uuids.plain };
        const { built, steps } = await S.complete(B.buildCharacter, { picks, base }, catalog);
        const draft = createDraft({ id: foundry.utils.randomID(), worldId: game.world.id,
          rules: game.settings.get("dnd5e", "rulesVersion") });
        draft.picks = picks;
        draft.abilities = { method: "standardArray", base: { ...base }, roll: null };
        draft.recipe = { steps: JSON.parse(JSON.stringify(steps)) };
        const EQ = await import("../scripts/rules/equipment-items.mjs");
        const core = await import("../scripts/rules/equipment.mjs");
        for ( const role of ["class", "background"] ) {
          const ctx = await EQ.equipmentContext(built.actor, built.actor.items.get(built.roots[role]), catalog);
          draft.equipment[role] = core.defaultSelection(ctx.tree, ctx);
        }
        draft.spells = spellContext(built, catalog).defaults;
        draft.details.name = "Homebrew Hero";
        const res = await validateDraft(draft, { catalog, userId: game.user.id });
        assert.deepEqual(res.errors, [], JSON.stringify(res.errors).slice(0, 400));
        assert.isTrue(res.ok);
      });
    });
  }, { displayName: "Character Creator: Imported content (GM)" });
}

import { MODULE_ID } from "../scripts/main.mjs";

/*
 * Species structure and the advancement inventory (from spikes 1.8 and 1.9), on the production rules adapter
 * and catalog: the SRD species list, what each species build puts on the character, and that every
 * advancement type in the allowed content is one the wizard's widgets cover.
 */

const BASE = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };
const FIXED = {
  legacy: { background: "Acolyte", class: "Fighter" },
  modern: { background: "Soldier", class: "Fighter" }
};
const SPECIES = {
  legacy: ["Dragonborn", "Half-Elf", "Half-Orc", "High Elf", "Hill Dwarf", "Human", "Lightfoot Halfling", "Rock Gnome", "Tiefling"],
  modern: ["Dragonborn", "Dwarf", "Elf, Drow", "Elf, High", "Elf, Wood", "Gnome, Forest", "Gnome, Rock", "Goliath", "Halfling",
    "Human", "Orc", "Tiefling, Abyssal", "Tiefling, Chthonic", "Tiefling, Infernal"]
};
const WITH_CHOICE = { legacy: ["Dragonborn", "High Elf"], modern: ["Goliath", "Human"] };

export function registerSpeciesBatch(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.species`, ({ describe, it, before, assert }) => {
    describe("Species structure (2014 subraces, 2024 lineages) and the advancement inventory", () => {
      let catalog;
      let steps;
      /** name → { built, results } */
      const rows = new Map();

      before(async function() {
        this.timeout(300_000);
        const B = await import("../scripts/rules/build.mjs");
        const S = await import("./support.mjs");
        steps = await import("../scripts/rules/steps.mjs");
        catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        const f = FIXED[rules()];
        for ( const sp of catalog.byCategory.species ) {
          const picks = { species: S.pick(catalog, "species", sp.name), background: S.pick(catalog, "background", f.background),
            class: S.pick(catalog, "class", f.class) };
          const { built } = await S.complete(B.buildCharacter, { picks, base: BASE }, catalog);
          rows.set(sp.name, { built, results: built.results });
        }
      });

      it("the catalog holds each species, subrace and lineage as its own item", () => {
        assert.deepEqual(catalog.byCategory.species.map(e => e.name).sort(), SPECIES[rules()]);
      });
      it("no build puts the same compendium item on the character twice from the same grant", () => {
        const dup = [];
        for ( const [name, { built }] of rows ) {
          const seen = new Set();
          for ( const i of built.actor.items ) {
            const key = `${i._stats?.compendiumSource}|${i.flags?.dnd5e?.advancementOrigin ?? ""}`;
            if ( seen.has(key) ) dup.push(`${name}: ${i.name}`);
            seen.add(key);
          }
        }
        assert.deepEqual(dup, []);
      });
      it("item choices inside a species: 2014 Dragonborn and High Elf, 2024 Goliath and Human only", () => {
        const withChoice = [...rows].filter(([, r]) => r.results.some(x => x.type === "ItemChoice" && x.path[0] === "species"))
          .map(([n]) => n).sort();
        assert.deepEqual(withChoice, WITH_CHOICE[rules()]);
      });
      it("movement and creature type come from the species", () => {
        for ( const [name, { built }] of rows ) {
          const race = built.actor.items.get(built.roots.species);
          assert.isAbove(built.actor.system.attributes.movement.walk, 0, `${name} speed`);
          if ( race.system.movement?.walk ) assert.equal(built.actor.system.attributes.movement.walk, race.system.movement.walk, `${name} speed`);
          assert.equal(built.actor.system.details.type?.value, race.system.type?.value, `${name} creature type`);
        }
      });
      it("the 2014 High Elf cantrip (no list in the data) is offered from every level-0 spell", async function() {
        if ( rules() !== "legacy" ) this.skip();
        const B = await import("../scripts/rules/build.mjs");
        const S = await import("./support.mjs");
        const picks = { species: S.pick(catalog, "species", "High Elf"), background: S.pick(catalog, "background", "Acolyte"),
          class: S.pick(catalog, "class", "Fighter") };
        const b = await B.buildCharacter({ picks, base: BASE, steps: [] }, { catalog, withOptions: true });
        const step = b.results.find(r => r.type === "ItemChoice" && r.path[0] === "species");
        const cantrips = catalog.byCategory.spell.filter(e => e.system?.level === 0);
        assert.equal(step.options.options.length, cantrips.length);
        assert.equal(rows.get("High Elf").results.find(r => r.advancementId === step.advancementId)?.data?.selected?.length, 1);
      });
      it("every advancement type in the allowed content is one the wizard covers", () => {
        const found = new Map();
        for ( const e of catalog.allowed.values() ) {
          for ( const a of Object.values(e.system?.advancement ?? {}) ) {
            if ( a?.type && !found.has(a.type) ) found.set(a.type, e.name);
          }
        }
        const unknown = [...found].filter(([type]) => !steps.KNOWN_TYPES.includes(type));
        assert.deepEqual(unknown, []);
        console.log(`${MODULE_ID} | advancement types (${rules()}): ${[...found.keys()].sort().join(", ")}`);
      });
    });
  }, { displayName: "Character Creator: Species and advancement inventory" });
}

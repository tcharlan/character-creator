import { MODULE_ID } from "../scripts/main.mjs";

/*
 * Level-1 class spells (PLAN 2.5): the production rules in scripts/rules/ on completed characters for every
 * SRD class, as Player A. Carries over the coverage of spike 1.7 (and the 1.9 extra-cantrip case).
 */

/** Every score 14 (+2) before species/background increases, so the oracle's prepared counts hold. */
const BASE = { str: 14, dex: 14, con: 14, int: 14, wis: 14, cha: 14 };
const FIXED = {
  legacy: { species: "Hill Dwarf", background: "Acolyte" },
  modern: { species: "Human", background: "Sage" }
};

/** 2024 order choices: the oracle row assumes the option without an extra cantrip; the last test takes the other. */
const ORDERS = { Cleric: ["Divine Order Choice", "Protector", "Thaumaturge"], Druid: ["Primal Order", "Warden", "Magician"] };

// Oracle: level-1 numbers from the 2014 / 2024 Player's Handbooks (test expectations only — the module
// reads them from dnd5e's data). [mode, cantrips, spells, spellbook?]; 2014 prepared = modifier + 1.
const ORACLE = {
  legacy: {
    Bard: ["known", 2, 4], Cleric: ["prepared", 3, 3], Druid: ["prepared", 2, 3], Sorcerer: ["known", 4, 2],
    Warlock: ["known", 2, 2], Wizard: ["prepared", 3, 3, 6], Paladin: ["none", 0, 0], Ranger: ["none", 0, 0]
  },
  modern: {
    Bard: ["prepared", 2, 4], Cleric: ["prepared", 3, 4], Druid: ["prepared", 2, 4], Paladin: ["prepared", 0, 2],
    Ranger: ["prepared", 0, 2], Sorcerer: ["prepared", 4, 2], Warlock: ["prepared", 2, 2], Wizard: ["prepared", 3, 4, 6]
  }
};

export function registerSpellBatches(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.spells`, ({ describe, it, before, assert }) => {
    describe("Level-1 class spells (scripts/rules) for every SRD class", () => {
      let B;
      let S;
      let SF;
      let catalog;
      /** name → { built, ctx } */
      const rows = new Map();
      const casters = () => [...rows].filter(([name]) => (ORACLE[rules()][name]?.[0] ?? "none") !== "none" || rows.get(name).ctx.req.caster);
      const picksFor = (over = {}) => {
        const f = { ...FIXED[rules()], ...over };
        return { species: S.pick(catalog, "species", f.species), background: S.pick(catalog, "background", f.background),
          class: S.pick(catalog, "class", f.class) };
      };

      /** Override for a 2024 order choice: the pool option whose name contains `option`. */
      const orderOverride = async (cls, option) => {
        const [title] = ORDERS[cls];
        const doc = await fromUuid(S.pick(catalog, "class", cls));
        const adv = doc.advancement.byType.ItemChoice.find(a => a.title === title);
        for ( const p of adv?.configuration.pool ?? [] ) {
          if ( (await fromUuid(p.uuid))?.name?.includes(option) ) return { [`${cls}/${title}`]: { selected: [p.uuid] } };
        }
        throw new Error(`${cls}: no "${option}" in ${title}`);
      };

      before(async function() {
        this.timeout(600_000);
        B = await import("../scripts/rules/build.mjs");
        S = await import("./support.mjs");
        SF = await import("../scripts/rules/spell-facts.mjs");
        catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        for ( const cls of catalog.byCategory.class ) {
          const over = rules() === "modern" && ORDERS[cls.name] ? await orderOverride(cls.name, ORDERS[cls.name][1]) : {};
          const { built } = await S.complete(B.buildCharacter, { picks: picksFor({ class: cls.name }), base: BASE }, catalog, over);
          rows.set(cls.name, { built, ctx: SF.spellContext(built, catalog) });
        }
        const summary = Object.fromEntries([...rows].map(([n, r]) => [n, { req: r.ctx.req, scale: r.ctx.facts.scale,
          slots: r.ctx.facts.slots, options: [r.ctx.options.cantrips.length, r.ctx.options.level1.length], owned: r.ctx.owned.size }]));
        console.log(`${MODULE_ID} | spells survey (${rules()}): ${JSON.stringify(summary)}`);
      });

      it("covers all 12 SRD classes", () => {
        assert.equal(rows.size, 12);
      });
      it("requirements read from dnd5e's data on the built character match the Player's Handbook", () => {
        const got = {};
        const want = {};
        for ( const [name, { ctx: { req } }] of rows ) {
          got[name] = [req.mode, req.cantrips, req.spells, ...(req.spellbook ? [req.spellbook] : [])];
          want[name] = ORACLE[rules()][name] ?? ["none", 0, 0];
        }
        assert.deepEqual(got, want);
      });
      it("Warlock uses pact magic with one level-1 slot", () => {
        const { facts, req } = rows.get("Warlock").ctx;
        assert.deepEqual([req.method, facts.slots.pact, facts.slots.pactLevel], ["pact", 1, 1]);
      });
      it("every caster's options (class list ∩ catalog) are enough, and only cantrips and level-1 spells", () => {
        for ( const [name, { ctx }] of casters() ) {
          const { req, options } = ctx;
          assert.isAtLeast(options.cantrips.length, req.cantrips, `${name} cantrips`);
          assert.isAtLeast(options.level1.length, Math.max(req.spells, req.spellbook), `${name} level 1`);
          for ( const u of [...options.cantrips, ...options.level1] ) assert.isTrue(catalog.isAllowed(u), `${name}: ${u}`);
        }
      });
      it("a default selection validates, embeds, and dnd5e counts the prepared spells as expected", async function() {
        this.timeout(120_000);
        const report = {};
        for ( const [name, { built, ctx }] of rows ) {
          const sel = ctx.defaults;
          assert.deepEqual(SF.checkDraftSpells(built, { spells: sel }, { catalog }), [], name);
          const data = await SF.spellCreationData(built, sel, { catalog });
          const actor = new Actor.implementation({ ...built.actor.toObject(), items: [...built.actor.toObject().items, ...data] });
          const cls = actor.items.find(i => i.type === "class");
          const expectPrepared = ctx.req.mode === "prepared" ? sel.spells.length : 0;
          const prep = cls.system.spellcasting?.preparation ?? {};
          assert.equal(prep.value ?? 0, expectPrepared, `${name}: dnd5e prepared count`);
          if ( expectPrepared ) assert.isAtMost(prep.value, prep.max, `${name}: over dnd5e's maximum`);
          const mine = actor.items.filter(i => i.type === "spell" && data.some(d => d._id === i.id));
          assert.lengthOf(mine, data.length, name);
          assert.isTrue(mine.every(i => i.system.classIdentifier === cls.identifier), `${name}: spells linked to the class`);
          report[name] = { cantrips: sel.cantrips.length, spells: sel.spells.length, spellbook: sel.spellbook.length, prepared: prep.value ?? 0 };
        }
        console.log(`${MODULE_ID} | spells embedded (${rules()}): ${JSON.stringify(report)}`);
      });
      it("tampered selections are rejected: off-list, level 2, too many, spells for a non-caster", () => {
        const { built, ctx } = rows.get("Cleric");
        const wizard = rows.get("Wizard").ctx;
        const offList = wizard.options.level1.find(u => !ctx.options.list.has(u));
        const level2 = [...ctx.options.levels].find(([, l]) => l === 2)?.[0];
        const codes = spells => SF.checkDraftSpells(built, { spells: { ...ctx.defaults, spells } }, { catalog }).map(e => e.code);
        assert.include(codes([offList]), "NOT_ON_LIST");
        assert.include(codes([level2]), "WRONG_LEVEL");
        assert.include(codes(ctx.options.level1.slice(0, ctx.req.spells + 1)), "SPELL_COUNT");
        const fighter = rows.get("Fighter");
        assert.deepEqual(SF.checkDraftSpells(fighter.built, { spells: ctx.defaults }, { catalog }).map(e => e.code), ["NOT_A_CASTER"]);
      });
      it("a spell the character already has from another source is ALREADY_KNOWN", async function() {
        this.timeout(120_000);
        // 2014 High Elf: a wizard cantrip; 2024 Sage: Magic Initiate (Wizard).
        const over = rules() === "legacy" ? { species: "High Elf", class: "Wizard" } : { class: "Wizard" };
        const { built } = await S.complete(B.buildCharacter, { picks: picksFor(over), base: BASE }, catalog);
        const ctx = SF.spellContext(built, catalog);
        const dup = [...ctx.owned].find(u => ctx.options.list.has(u));
        assert.exists(dup, "no owned spell on the Wizard list");
        assert.notInclude([...ctx.defaults.cantrips, ...ctx.defaults.spellbook], dup, "defaults skip owned spells");
        const level = ctx.options.levels.get(dup);
        const sel = foundry.utils.deepClone(ctx.defaults);
        if ( level === 0 ) sel.cantrips[0] = dup;
        else {
          sel.spells = sel.spells.map(u => (u === sel.spellbook[0] ? dup : u));
          sel.spellbook[0] = dup;
        }
        const codes = SF.checkDraftSpells(built, { spells: sel }, { catalog }).map(e => e.code);
        assert.deepEqual(codes, ["ALREADY_KNOWN"]);
      });
      it("2024 Thaumaturge / Magician: the extra cantrip counts (read from the built character)", async function() {
        if ( rules() !== "modern" ) this.skip();
        this.timeout(120_000);
        for ( const [cls, [, , option]] of Object.entries(ORDERS) ) {
          const { built } = await S.complete(B.buildCharacter, { picks: picksFor({ class: cls }), base: BASE }, catalog,
            await orderOverride(cls, option));
          const ctx = SF.spellContext(built, catalog);
          assert.equal(ctx.req.cantrips, ORACLE.modern[cls][1] + 1, `${cls} ${option}`);
          assert.deepEqual(SF.checkDraftSpells(built, { spells: ctx.defaults }, { catalog }), []);
        }
      });
      it("GM restrictions narrow the options; a list left with exactly the count is the default (D4)", async () => {
        const { built, ctx } = rows.get("Cleric");
        const keep = ctx.options.cantrips.slice(0, ctx.req.cantrips);
        const drop = new Set(ctx.options.cantrips.slice(ctx.req.cantrips));
        const C = await import("../scripts/catalog/catalog.mjs");
        const norm = u => u.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.");
        const narrowed = await C.getCatalog({ restrictions: { packs: null,
          categories: { spell: catalog.byCategory.spell.map(e => e.uuid).filter(u => !drop.has(norm(u))) } } });
        const n = SF.spellContext(built, narrowed);
        assert.deepEqual(n.options.cantrips, keep);
        assert.deepEqual(n.defaults.cantrips, keep);
        const dropped = [...drop][0];
        const sel = { ...ctx.defaults, cantrips: [dropped, ...keep.slice(1)] };
        assert.include(SF.checkDraftSpells(built, { spells: sel }, { catalog: narrowed }).map(e => e.code), "NOT_ON_LIST");
      });
    });
  }, { displayName: "Character Creator: Class spells" });
}

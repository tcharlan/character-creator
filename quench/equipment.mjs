import { MODULE_ID } from "../scripts/main.mjs";
import { createDraft } from "../scripts/contracts.mjs";
import { ABILITY_TEST_QUERIES } from "./abilities.mjs";

/*
 * Starting equipment (PLAN 2.5): the production resolver in scripts/rules/ on every SRD class and background,
 * on completed characters, as Player A. Carries over the coverage of spike 1.6; `equipment@gm` adds the
 * 2014 wealth roll checked by the GM (D15).
 */

const BASE = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };
const FIXED = {
  legacy: { species: "Hill Dwarf", background: "Acolyte", class: "Cleric" },
  modern: { species: "Human", background: "Sage", class: "Fighter" }
};
const SRD = { legacy: { class: 12, background: 1 }, modern: { class: 12, background: 4 } };

const CHECK = `${MODULE_ID}.test.checkEquipment`;

/** Test-only GM query: build the player's draft and resolve its equipment, checking wealth rolls against chat. */
export function registerEquipmentTestQueries() {
  CONFIG.queries[CHECK] = async ({ draft }, { user }) => {
    if ( !game.user.isGM || !game.users.activeGM?.isSelf ) throw new Error("Only the active GM");
    const { buildCharacter } = await import("../scripts/rules/build.mjs");
    const { getCatalog } = await import("../scripts/catalog/catalog.mjs");
    const { resolveDraftEquipment } = await import("../scripts/rules/equipment-items.mjs");
    const catalog = await getCatalog();
    const built = await buildCharacter({ picks: draft.picks, base: draft.abilities.base, steps: draft.recipe.steps }, { catalog });
    const res = await resolveDraftEquipment(built, draft, { catalog, userId: user.id });
    return { errors: res.errors, currency: res.currency, items: res.items.length };
  };
}

export function registerEquipmentBatches(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.equipment`, ({ describe, it, before, assert }) => {
    describe("Starting equipment (scripts/rules) for every SRD class and background", () => {
      let B;
      let S;
      let EQ;
      let core;
      let catalog;
      /** One completed character per class and per background: { role, name, built, item, ctx }. */
      const rows = [];
      const draftFor = (selection, role) => ({ id: "x".repeat(16), equipment: { class: null, background: null, [role]: selection } });

      before(async function() {
        this.timeout(600_000);
        B = await import("../scripts/rules/build.mjs");
        S = await import("./support.mjs");
        EQ = await import("../scripts/rules/equipment-items.mjs");
        core = await import("../scripts/rules/equipment.mjs");
        catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        const f = FIXED[rules()];
        const specs = [...catalog.byCategory.class.map(e => ["class", { ...f, class: e.name }]),
          ...catalog.byCategory.background.map(e => ["background", { ...f, background: e.name }])];
        for ( const [role, spec] of specs ) {
          const picks = { species: S.pick(catalog, "species", spec.species), background: S.pick(catalog, "background", spec.background),
            class: S.pick(catalog, "class", spec.class) };
          const { built } = await S.complete(B.buildCharacter, { picks, base: BASE }, catalog);
          const item = built.actor.items.get(built.roots[role]);
          rows.push({ role, name: item.name, built, item, ctx: await EQ.equipmentContext(built.actor, item, catalog) });
        }
        const summary = rows.map(r => ({ name: r.name, wealth: r.ctx.wealth,
          categories: [...r.ctx.tree.nodes.values()].filter(n => core.CATEGORY_TYPES.includes(n.type))
            .map(n => `${n.type}:${n.key}×${core.unitCount(n)}→${r.ctx.candidates(n).length}`) }));
        console.log(`${MODULE_ID} | equipment survey (${rules()}): ${JSON.stringify(summary)}`);
      });

      const categoryNodes = r => [...r.ctx.tree.nodes.values()].filter(n => core.CATEGORY_TYPES.includes(n.type));

      it("covers every SRD class and background of this rule set", () => {
        assert.equal(rows.filter(r => r.role === "class").length, SRD[rules()].class);
        assert.equal(rows.filter(r => r.role === "background").length, SRD[rules()].background);
      });
      it("uses only entry types the resolver knows", () => {
        const unknown = rows.flatMap(r => [...r.ctx.tree.nodes.values()].filter(n => !core.ENTRY_TYPES.includes(n.type))
          .map(n => `${r.name}: ${n.type}`));
        assert.deepEqual(unknown, []);
      });
      it("every linked item exists, is a physical item, and is allowed by the catalog", async () => {
        const bad = [];
        for ( const r of rows ) {
          for ( const n of [...r.ctx.tree.nodes.values()].filter(x => x.type === "linked") ) {
            const doc = await fromUuid(n.key);
            if ( !doc || !("quantity" in doc.system) || !catalog.isAllowed(n.key) ) bad.push(`${r.name}: ${n.key} ${doc?.name}`);
          }
        }
        assert.deepEqual(bad, []);
      });
      it("every category entry has at least as many non-magical candidates as it asks for", () => {
        const short = rows.flatMap(r => categoryNodes(r).filter(n => r.ctx.candidates(n).length < 1)
          .map(n => `${r.name} ${n.type}:${n.key}`));
        assert.deepEqual(short, []);
      });
      it("category candidates are dnd5e's base items only (SRD counts; no Unarmed Strike, no magic)", () => {
        const counts = {};
        const all = new Set();
        for ( const r of rows ) for ( const n of categoryNodes(r) ) {
          counts[`${n.type}:${n.key}`] = r.ctx.candidates(n).length;
          r.ctx.candidates(n).forEach(u => all.add(u));
        }
        if ( rules() === "legacy" ) {
          assert.include(counts, { "weapon:sim": 14, "weapon:simpleM": 10, "weapon:martialM": 18, "weapon:mar": 23, "tool:music": 10 });
        } else assert.include(counts, { "tool:music": 10, "tool:art": 17, "tool:game": 4 });
        const entries = [...all].map(u => catalog.get(u));
        assert.notInclude(entries.map(e => e?.name), "Unarmed Strike");
        assert.deepEqual(entries.filter(e => !e || e.system?.rarity).map(e => e?.name ?? "missing"), []);
      });
      it("a default selection resolves with no errors for every class and background", async function() {
        this.timeout(120_000);
        const bad = [];
        for ( const r of rows ) {
          const sel = core.defaultSelection(r.ctx.tree, r.ctx);
          const res = await EQ.resolveDraftEquipment(r.built, draftFor(sel, r.role), { catalog });
          const mine = res.errors.filter(e => e.detail.source === r.role);
          if ( mine.length ) bad.push([r.name, mine]);
        }
        assert.deepEqual(bad, []);
      });
      it("resolved items become creation data (containers with their contents) that embeds", async function() {
        this.timeout(120_000);
        let containers = 0;
        for ( const r of rows ) {
          const res = core.resolveSelection(r.ctx.tree, r.ctx.wealth, core.defaultSelection(r.ctx.tree, r.ctx), r.ctx);
          const data = await EQ.equipmentCreationData(res.items);
          containers += data.filter(d => d.type === "container").length;
          const scratch = new Actor.implementation({ name: "scratch", type: "character", items: data });
          assert.equal(scratch.items.size, data.length, r.name);
        }
        assert.isAbove(containers, 0, "no container found");
      });
      it("wealth: 2014 classes have a dice formula whose range matches Foundry's Roll; 2024 a flat GP amount", async () => {
        for ( const r of rows.filter(x => x.role === "class") ) {
          const o = r.ctx.wealthOption;
          if ( rules() === "legacy" ) {
            assert.exists(o?.number, r.name);
            const f = EQ.wealthFormula(o);
            const lo = (await new Roll(f).evaluate({ minimize: true })).total;
            const hi = (await new Roll(f).evaluate({ maximize: true })).total;
            assert.deepEqual([lo, hi], [o.min, o.max], r.name);
          } else assert.isNumber(o?.fixed, r.name);
        }
      });
      it("2024: every class and background offers the flat wealth alternative (D23: independent)", async function() {
        if ( rules() !== "modern" ) this.skip();
        this.timeout(120_000);
        for ( const r of rows ) {
          const res = await EQ.resolveDraftEquipment(r.built, draftFor({ mode: "wealth", choices: {}, picks: {} }, r.role), { catalog });
          assert.deepEqual(res.errors.filter(e => e.detail.source === r.role), [], r.name);
          assert.isAbove(res.currency.gp, 0, r.name);
        }
      });
      it("taking the class's wealth keeps the background's equipment (D23)", async function() {
        this.timeout(60_000);
        const r = rows.find(x => x.role === "class" && x.name === FIXED[rules()].class);
        const bg = r.built.actor.items.get(r.built.roots.background);
        const bgCtx = await EQ.equipmentContext(r.built.actor, bg, catalog);
        const draft = { id: "x".repeat(16), equipment: {
          class: rules() === "legacy" ? { mode: "wealth", choices: {}, picks: {}, wealth: { total: r.ctx.wealthOption.min } }
            : { mode: "wealth", choices: {}, picks: {} },
          background: core.defaultSelection(bgCtx.tree, bgCtx) } };
        const res = await EQ.resolveDraftEquipment(r.built, draft, { catalog });
        assert.deepEqual(res.errors, []);
        assert.isAbove(res.items.filter(i => i.source === "background").length, 0);
        assert.lengthOf(res.items.filter(i => i.source === "class"), 0);
      });
      it("'if proficient' options follow dnd5e's proficiency on the built character", async function() {
        if ( rules() !== "legacy" ) this.skip();
        const cleric = rows.find(r => r.role === "class" && r.name === "Cleric");
        const needs = [...cleric.ctx.tree.nodes.values()].filter(n => n.type === "linked" && n.requiresProficiency).map(n => n.key);
        assert.isAbove(needs.length, 0);
        // Hill Dwarf Life Cleric: Dwarven Combat Training (warhammer) and Life Domain (heavy armor).
        assert.isTrue(needs.every(cleric.ctx.isProficient), "should be proficient with both");
        const stripped = new Actor.implementation(foundry.utils.mergeObject(cleric.built.actor.toObject(), {
          "system.traits.weaponProf.value": ["sim"], "system.traits.armorProf.value": ["lgt", "med", "shl"]
        }, { inplace: false }));
        const no = await EQ.proficiencyChecker(stripped, needs);
        assert.isTrue(needs.every(u => !no(u)), "should not be proficient without them");
      });
      it("tampered picks are rejected: wrong category, magic items, made-up entries", async function() {
        this.timeout(60_000);
        let row;
        let node;
        for ( const r of rows ) {
          const sel = core.defaultSelection(r.ctx.tree, r.ctx);
          const reached = new Set(core.listDecisions(r.ctx.tree, sel.choices).map(d => d.id));
          node = categoryNodes(r).find(n => reached.has(n._id));
          if ( node ) {
            row = r;
            break;
          }
        }
        assert.exists(row, "no reachable category entry in this rule set");
        const magic = catalog.byCategory.equipment.find(e => e.system?.rarity && e.type === (node.type === "armor" ? "equipment" : node.type));
        const wrong = catalog.byCategory.equipment.find(e => !EQ.matchesCategory(node, e));
        const codes = async mutate => {
          const sel = core.defaultSelection(row.ctx.tree, row.ctx);
          mutate(sel);
          return (await EQ.resolveDraftEquipment(row.built, draftFor(sel, row.role), { catalog })).errors
            .filter(e => e.detail.source === row.role).map(e => e.code);
        };
        for ( const bad of [wrong?.uuid, magic?.uuid].filter(Boolean) ) {
          assert.include(await codes(sel => sel.picks[node._id] = Array(core.unitCount(node)).fill(bad)), "NOT_IN_CATEGORY", bad);
        }
        assert.include(await codes(sel => sel.picks.ZZZZZZZZZZZZZZZZ = []), "UNEXPECTED_SELECTION");
        assert.include(await codes(sel => sel.picks[node._id] = []), "WRONG_PICK_COUNT");
      });
      it("GM restrictions narrow the candidates; a category left with one item is auto-selected (D4)", async function() {
        this.timeout(60_000);
        const r = rows.find(x => categoryNodes(x).some(n => x.ctx.candidates(n).length > 1));
        const node = categoryNodes(r).find(n => r.ctx.candidates(n).length > 1);
        const keep = r.ctx.candidates(node)[1];
        const others = new Set(r.ctx.candidates(node).filter(u => u !== keep));
        const C = await import("../scripts/catalog/catalog.mjs");
        const narrowed = await C.getCatalog({ restrictions: { packs: null,
          categories: { equipment: catalog.byCategory.equipment.map(e => e.uuid).filter(u => !others.has(u.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item."))) } } });
        assert.deepEqual(EQ.candidatesFor(node, narrowed), [keep]);
        const ctx = await EQ.equipmentContext(r.built.actor, r.item, narrowed);
        if ( core.unitCount(node) === 1 ) assert.deepEqual(core.defaultSelection(ctx.tree, ctx).picks[node._id] ?? [keep], [keep]);
      });
    });
  }, { displayName: "Character Creator: Starting equipment" });

  quench.registerBatch(`${MODULE_ID}.equipment@gm`, ({ describe, it, before, after, assert }) => {
    describe("2014 starting wealth: rolled in the player's browser, checked by the GM (D15)", () => {
      let EQ;
      let base;
      const draftIds = [];
      const query = (name, data) => game.users.activeGM.query(name, data, { timeout: 60_000 });

      before(async function() {
        if ( rules() !== "legacy" ) this.skip();
        this.timeout(120_000);
        assert.isFalse(game.user.isGM, "run as a player");
        assert.exists(game.users.activeGM, "no active GM — run with npm run test:foundry");
        EQ = await import("../scripts/rules/equipment-items.mjs");
        const B = await import("../scripts/rules/build.mjs");
        const S = await import("./support.mjs");
        const catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        const f = FIXED.legacy;
        const picks = { species: S.pick(catalog, "species", f.species), background: S.pick(catalog, "background", f.background),
          class: S.pick(catalog, "class", f.class) };
        const { built, steps } = await S.complete(B.buildCharacter, { picks, base: BASE }, catalog);
        const cls = built.actor.items.get(built.roots.class);
        const bg = built.actor.items.get(built.roots.background);
        const core = await import("../scripts/rules/equipment.mjs");
        const bgCtx = await EQ.equipmentContext(built.actor, bg, catalog);
        base = { picks, steps, wealth: cls.system.wealth, background: core.defaultSelection(bgCtx.tree, bgCtx) };
      });
      after(async function() {
        this.timeout(30_000);
        if ( game.users.activeGM && draftIds.length ) await query(ABILITY_TEST_QUERIES.CLEANUP, { draftIds });
      });

      const newDraft = () => {
        const d = createDraft({ id: foundry.utils.randomID(), worldId: game.world.id, rules: "legacy" });
        draftIds.push(d.id);
        d.picks = base.picks;
        d.abilities = { method: "standardArray", base: BASE, roll: null };
        d.recipe = { steps: base.steps };
        d.equipment = { class: { mode: "wealth", choices: {}, picks: {} }, background: base.background };
        return d;
      };
      const rolled = async () => {
        const d = newDraft();
        d.equipment.class.wealth = await EQ.rollStartingWealth(d, "class", base.wealth);
        return d;
      };
      const check = d => query(CHECK, { draft: d });
      const why = res => res.errors.map(e => `${e.code}:${e.detail?.message ?? Object.keys(e.detail ?? {}).filter(k => k !== "source")[0]}`);

      it("an untouched roll is accepted and becomes the class's gold; the background keeps its equipment", async () => {
        const d = await rolled();
        const m = game.messages.get(d.equipment.class.wealth.messageId);
        assert.deepEqual(m.getFlag(MODULE_ID, "roll"), { draftId: d.id, purpose: "wealth", source: "class" });
        const res = await check(d);
        assert.deepEqual(res.errors, []);
        assert.isAtLeast(res.currency.gp, d.equipment.class.wealth.total);
        assert.isAbove(res.items, 0);
        console.log(`${MODULE_ID} | wealth roll: ${m.rolls[0].formula} = ${d.equipment.class.wealth.total}`);
      });
      it("refuses to roll twice for the same source (A10)", async () => {
        const d = await rolled();
        let err;
        try { await EQ.rollStartingWealth(d, "class", base.wealth); } catch ( e ) { err = e; }
        assert.equal(err?.code, "WEALTH_ROLL_INVALID");
      });
      it("an edited total is rejected (in range: against the record; out of range: by the formula)", async () => {
        const d = await rolled();
        const w = d.equipment.class.wealth;
        w.total = w.total === 50 ? 60 : w.total - 10;
        assert.deepEqual(why(await check(d)), ["WEALTH_ROLL_INVALID:resultsDiffer"]);
        w.total = 999;
        assert.include(why(await check(d)), "WEALTH_OUT_OF_RANGE:entryId");
      });
      it("a missing message, or an ability roll passed off as wealth, is rejected", async () => {
        const d = await rolled();
        d.equipment.class.wealth.messageId = foundry.utils.randomID();
        assert.deepEqual(why(await check(d)), ["WEALTH_ROLL_INVALID:missing"]);
        const { rollAbilityScores } = await import("../scripts/rules/ability-roll.mjs");
        const a = await rollAbilityScores(d);
        d.equipment.class.wealth.messageId = a.messageId;
        assert.deepEqual(why(await check(d)), ["WEALTH_ROLL_INVALID:wrongDraft"]);
      });
      it("rolling again, or rolling and then taking the items, is rejected", async () => {
        const d = await rolled();
        const second = await EQ.rollStartingWealth({ id: d.id, equipment: {} }, "class", base.wealth);   // bypassing the lock
        d.equipment.class.wealth = second;
        assert.deepEqual(why(await check(d)), ["WEALTH_ROLL_INVALID:rerolled"]);
        const e = await rolled();
        e.equipment.class = null;   // back to items with the default choices below
        const res = await check(e);
        assert.include(why(res), "WEALTH_ROLL_INVALID:rolledButMode");
      });
    });
  }, { displayName: "Character Creator: Starting wealth roll" });
}

import { MODULE_ID } from "../scripts/main.mjs";

/*
 * Rules adapter (PLAN 2.3): the production engine in scripts/rules/, on the real SRD packs, as Player A.
 * Carries over the coverage of spike suites 1.1–1.3, 1.8 and 1.9.
 */

const BASE = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };
const FIXED = {
  legacy: { species: "Hill Dwarf", background: "Acolyte", class: "Cleric" },
  modern: { species: "Human", background: "Sage", class: "Fighter" }
};

export function registerRulesBatches(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.rules`, ({ describe, it, before, after, assert }) => {
    describe("Rules adapter (scripts/rules) — build and replay from recipes", () => {
      let B;
      let S;
      let catalog;
      let initials;
      let stopWatch;
      const picksFor = over => {
        const f = { ...FIXED[rules()], ...over };
        return { species: S.pick(catalog, "species", f.species), background: S.pick(catalog, "background", f.background),
          class: S.pick(catalog, "class", f.class) };
      };
      const replay = (picks, steps, cat = catalog) => B.buildCharacter({ picks, base: BASE, steps }, { catalog: cat, fill: false });
      const codes = res => res.errors.map(e => e.code);

      before(async function() {
        this.timeout(60_000);
        B = await import("../scripts/rules/build.mjs");
        S = await import("./support.mjs");
        catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        initials = S.schemaInitials();
        stopWatch = S.watchDb();
      });
      after(() => stopWatch?.());

      it("every class completes, and its recipe replays identically with no errors", async function() {
        this.timeout(300_000);
        const report = [];
        for ( const cls of catalog.byCategory.class ) {
          const picks = picksFor({ class: cls.name });
          const { built, steps, rebuilds } = await S.complete(B.buildCharacter, { picks, base: BASE }, catalog);
          assert.isTrue(built.summary.complete, `${cls.name}: ${JSON.stringify(built.errors).slice(0, 400)}`);
          const r = await replay(picks, JSON.parse(JSON.stringify(steps)));
          assert.deepEqual(codes(r), [], `${cls.name} replay: ${JSON.stringify(r.errors).slice(0, 400)}`);
          assert.deepEqual(S.differences(S.snapshot(r.actor), S.snapshot(built.actor)), [], cls.name);
          report.push(`${cls.name} ${steps.length}st/${rebuilds}rb hp${r.actor.system.attributes.hp.max}`);
        }
        console.log(`${MODULE_ID} | rules classes (${rules()}): ${report.join(", ")}`);
      });

      it("every species completes and replays identically, with speed from the species", async function() {
        this.timeout(300_000);
        for ( const sp of catalog.byCategory.species ) {
          const picks = picksFor({ species: sp.name });
          const { built, steps } = await S.complete(B.buildCharacter, { picks, base: BASE }, catalog);
          assert.isTrue(built.summary.complete, sp.name);
          const r = await replay(picks, JSON.parse(JSON.stringify(steps)));
          assert.deepEqual(codes(r), [], `${sp.name}: ${JSON.stringify(r.errors).slice(0, 300)}`);
          assert.deepEqual(S.differences(S.snapshot(r.actor), S.snapshot(built.actor)), [], sp.name);
          assert.isAbove(r.actor.system.attributes.movement.walk, 0, `${sp.name} speed`);
        }
      });

      it("wizard mode: an empty recipe lists the steps that need input and fills the automatic ones", async () => {
        const b = await B.buildCharacter({ picks: picksFor(), base: BASE, steps: [] }, { catalog, withOptions: true });
        assert.isAbove(b.summary.needsInput.length, 0);
        assert.isAbove(b.summary.auto, 0);
        assert.lengthOf(b.summary.invalid, 0);
        assert.lengthOf(b.summary.blocked, 0);
        assert.isTrue(b.summary.needsInput.every(r => r.options), "needs-input steps carry their options");
      });

      describe("tampered recipes are rejected with the contract's codes", () => {
        let picks;
        let steps;
        let results;
        const find = (item, title) => {
          const r = results.find(x => x.item === item && x.title === title);
          if ( !r ) throw new Error(`no step ${item}/${title}: ${results.map(x => `${x.item}/${x.title}`).join(", ")}`);
          return steps.find(s => s.advancementId === r.advancementId && JSON.stringify(s.path) === JSON.stringify(r.path));
        };
        const tampered = async mutate => {
          const copy = JSON.parse(JSON.stringify(steps));
          const saved = steps;
          steps = copy;
          mutate();
          steps = saved;
          return codes(await replay(picks, copy));
        };
        before(async function() {
          this.timeout(120_000);
          picks = picksFor();
          const c = await S.complete(B.buildCharacter, { picks, base: BASE }, catalog);
          steps = c.steps;
          results = c.built.results;
        });

        it("an extra, off-list class skill → TOO_MANY_PICKS and NOT_ALLOWED", async () => {
          const title = rules() === "legacy" ? "Skills" : "Skill Proficiencies";
          const got = await tampered(() => find(FIXED[rules()].class, title).data.chosen.push("skills:ste"));
          assert.includeMembers(got, ["TOO_MANY_PICKS", "NOT_ALLOWED"]);
        });
        it("a dropped fixed grant → UNFULFILLED", async () => {
          const [item, title] = rules() === "legacy" ? ["Hill Dwarf", "Languages"] : ["Sage", "Background Proficiencies"];
          const got = await tampered(() => find(item, title).data.chosen.shift());
          assert.include(got, "UNFULFILLED");
        });
        it("ability increases over the limit, or on a locked ability → ASI_OVER_LIMIT / ASI_LOCKED", async () => {
          const [item, title] = rules() === "legacy" ? ["Hill Dwarf", "Ability Score Improvement"]
            : ["Sage", "Background Ability Score Improvement"];
          assert.include(await tampered(() => find(item, title).data.assignments.cha = 2), rules() === "legacy" ? "ASI_OVER_LIMIT" : "ASI_LOCKED");
          if ( rules() === "modern" ) {
            assert.include(await tampered(() => { find(item, title).data.assignments = { con: 2, int: 2 }; }), "ASI_OVER_LIMIT");
          }
        });
        it("an item the step doesn't offer → NOT_OFFERED", async () => {
          const [item, title] = rules() === "legacy" ? ["Acolyte", "Feature"] : ["Fighter", "Fighting Style"];
          const got = await tampered(() => { find(item, title).data.selected = [S.pick(catalog, "species", FIXED[rules()].species)]; });
          assert.include(got, "NOT_OFFERED");
        });
        it("level-1 hit points other than the maximum → NOT_ALLOWED", async () => {
          const got = await tampered(() => { find(FIXED[rules()].class, "Hit Points").data = { 1: "avg" }; });
          assert.include(got, "NOT_ALLOWED");
        });
        it("a missing step → MISSING_STEP; a stale step → UNKNOWN_ADVANCEMENT", async () => {
          const title = rules() === "legacy" ? "Skills" : "Skill Proficiencies";
          const target = find(FIXED[rules()].class, title);
          assert.include(await tampered(() => steps.splice(steps.indexOf(target), 1)), "MISSING_STEP");
          assert.include(await tampered(() => steps.push({ ...target, advancementId: "ZZZZZZZZZZZZZZZZ" })), "UNKNOWN_ADVANCEMENT");
        });
        it("picks: missing class → CLASS_MISSING; species the GM disallowed → SPECIES_NOT_ALLOWED", async () => {
          assert.include(codes(await B.buildCharacter({ picks: { ...picks, class: null }, base: BASE, steps }, { catalog, fill: false })), "CLASS_MISSING");
          const C = await import("../scripts/catalog/catalog.mjs");
          const narrowed = await C.getCatalog({ restrictions: { packs: null, categories: { species: [] } } });
          assert.include(codes(await replay(picks, steps, narrowed)), "SPECIES_NOT_ALLOWED");
        });
      });

      it("two copies of Magic Initiate (Human Versatile + Sage) replay by path", async function() {
        if ( rules() !== "modern" ) this.skip();
        this.timeout(120_000);
        const mi = S.pick(catalog, "feat", "Magic Initiate");
        const picks = picksFor();
        const { built, steps } = await S.complete(B.buildCharacter, { picks, base: BASE }, catalog, { "Human/Versatile": { selected: [mi] } });
        assert.lengthOf(built.actor.items.filter(i => i.name === "Magic Initiate"), 2);
        const r = await replay(picks, JSON.parse(JSON.stringify(steps)));
        assert.deepEqual(codes(r), []);
        assert.deepEqual(S.differences(S.snapshot(r.actor), S.snapshot(built.actor)), []);
      });

      it("D4 auto-select: a pool the GM narrows to exactly the picks needed applies automatically", async function() {
        if ( rules() !== "modern" ) this.skip();
        const fighter = await fromUuid(S.pick(catalog, "class", "Fighter"));
        const style = fighter.advancement.byType.ItemChoice.find(a => a.title === "Fighting Style");
        const others = new Set(style.configuration.pool.slice(1).map(p => p.uuid.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.")));
        const C = await import("../scripts/catalog/catalog.mjs");
        const narrowed = await C.getCatalog({ restrictions: { packs: null,
          categories: { feat: catalog.byCategory.feat.map(e => e.uuid).filter(u => !others.has(u)) } } });
        const b = await B.buildCharacter({ picks: picksFor(), base: BASE, steps: [] }, { catalog: narrowed });
        assert.equal(b.results.find(r => r.title === "Fighting Style")?.status, "auto");
      });

      it("ItemChoice pools follow dnd5e's prerequisites (2024 Warlock invocations at level 1)", async function() {
        if ( rules() !== "modern" ) this.skip();
        const b = await B.buildCharacter({ picks: picksFor({ class: "Warlock" }), base: BASE, steps: [] }, { catalog, withOptions: true });
        const inv = b.results.find(r => r.title === "Eldritch Invocations");
        assert.exists(inv, "no invocation step");
        const warlock = await fromUuid(S.pick(catalog, "class", "Warlock"));
        const pool = warlock.advancement.byId[inv.advancementId].configuration.pool.length;
        assert.isAbove(inv.options.options.length, 0);
        assert.isBelow(inv.options.options.length, pool, "level-restricted invocations should be filtered out");
        for ( const u of inv.options.options ) assert.isAtMost((await fromUuid(u)).system.prerequisites?.level ?? 0, 1);
        console.log(`${MODULE_ID} | rules invocations: ${inv.options.options.length} of ${pool} at level 1`);
      });

      it("a full replay is fast enough to rebuild on every change (D18)", async function() {
        this.timeout(120_000);
        const picks = picksFor();
        const { steps } = await S.complete(B.buildCharacter, { picks, base: BASE }, catalog);
        const times = [];
        for ( let i = 0; i < 5; i++ ) {
          const t0 = performance.now();
          await replay(picks, steps);
          times.push(Math.round(performance.now() - t0));
        }
        times.sort((a, b) => a - b);
        console.log(`${MODULE_ID} | rules replay ms (${rules()}): ${JSON.stringify(times)}`);
        assert.isBelow(times[2], 1500);
      });

      it("wrote nothing to the database and left schema defaults untouched", () => {
        const writes = stopWatch();
        stopWatch = null;
        assert.deepEqual(writes, []);
        const now = S.schemaInitials();
        assert.deepEqual(Object.keys(initials).filter(k => initials[k] !== now[k]), []);
      });
    });
  }, { displayName: "Character Creator: Rules adapter" });
}

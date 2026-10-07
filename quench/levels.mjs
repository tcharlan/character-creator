import { MODULE_ID } from "../scripts/main.mjs";
import { legitDraft } from "./validator.mjs";

/*
 * Characters above level 1 (PLAN 8.2; D32–D38): the production replay level by level, other classes, hit points
 * by the GM's method, an ASI taken as a feat, spells "of a level you can cast", checkpoints and slicing, and the
 * validator holding a draft to the level and classes the GM allows.
 */

const BASE = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };
const FIXED = {
  legacy: { species: "Hill Dwarf", background: "Acolyte" },
  modern: { species: "Human", background: "Sage" }
};

export function registerLevelsBatches(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.levels`, ({ describe, it, before, after, assert }) => {
    describe("Characters above level 1 (scripts/rules/build.mjs)", () => {
      let B;
      let S;
      let V;
      let catalog;
      let stopWatch;
      let initials;
      const picksFor = cls => ({ species: S.pick(catalog, "species", FIXED[rules()].species),
        background: S.pick(catalog, "background", FIXED[rules()].background), class: S.pick(catalog, "class", cls) });
      const codes = r => r.errors.map(e => e.code);

      /** Answer every open step of one replay (one trait and one item choice at a time), rebuild, repeat. */
      async function complete(input, options = {}) {
        let steps = [];
        let built;
        for ( let round = 0; round < 80; round++ ) {
          built = await B.buildCharacter({ ...input, steps }, { catalog, withOptions: true, ...options });
          let open = built.results.filter(r => r.status === "needsInput");
          if ( !open.length ) break;
          const trait = open.find(r => r.type === "Trait");
          const choice = open.find(r => r.type === "ItemChoice");
          open = open.filter(r => ((r.type !== "Trait") || (r === trait)) && ((r.type !== "ItemChoice") || (r === choice)));
          steps = [...built.recipe.steps, ...open.map(r => ({ path: r.path, advancementId: r.advancementId, level: r.level,
            data: input.answers?.(r) ?? S.answer(r.options) }))];
        }
        return { built, steps: built.recipe.steps };
      }
      const replay = (input, steps, options = {}) => B.buildCharacter({ ...input, steps: JSON.parse(JSON.stringify(steps)) },
        { catalog, fill: false, ...options });

      before(async function() {
        this.timeout(60_000);
        B = await import("../scripts/rules/build.mjs");
        S = await import("./support.mjs");
        V = await import("../scripts/rules/validate.mjs");
        catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        initials = S.schemaInitials();
        stopWatch = S.watchDb();
      });
      after(() => stopWatch?.());

      it("every class at level 5 completes, and its recipe replays identically with no errors", async function() {
        this.timeout(900_000);
        for ( const cls of catalog.byCategory.class ) {
          const input = { picks: picksFor(cls.name), base: BASE, level: 5 };
          const { built, steps } = await complete(input);
          assert.isTrue(built.summary.complete, `${cls.name}: ${JSON.stringify(built.errors).slice(0, 300)}`);
          const r = await replay(input, steps);
          assert.deepEqual(codes(r), [], `${cls.name}: ${JSON.stringify(r.errors).slice(0, 300)}`);
          assert.deepEqual(S.differences(S.snapshot(r.actor), S.snapshot(built.actor)), [], cls.name);
          assert.equal(r.actor.system.details.level, 5, cls.name);
          assert.ok(r.actor.items.find(i => i.type === "subclass"), `${cls.name} has its subclass by level 5`);
        }
      });

      it("hit points: the maximum at level 1, the average after (D33); a step claiming more is refused", async function() {
        this.timeout(120_000);
        const input = { picks: picksFor("Fighter"), base: BASE, level: 4 };
        const { built, steps } = await complete(input);
        const con = built.actor.system.abilities.con.mod;
        assert.equal(built.actor.system.attributes.hp.max, (10 + con) + (3 * (6 + con)), "d10: 10, then 6 a level");
        const hp = steps.find(s => (s.level === 3) && (s.data?.[3] === "avg"));
        assert.ok(hp, "level 3 takes the average");
        const tampered = steps.map(s => (s === hp ? { ...s, data: { 3: 10 } } : s));
        assert.include(codes(await replay(input, tampered)), "NOT_ALLOWED", "a rolled 10 with no roll behind it");
      });

      it("multiclassing: the other class joins at its first level, roots at multiclass:<identifier>, takes no first-level maximum", async function() {
        this.timeout(300_000);
        const wizard = S.pick(catalog, "class", "Wizard");
        const input = { picks: picksFor("Fighter"), base: BASE, level: 5, multiclass: [{ uuid: wizard, levels: 2 }] };
        const { built, steps } = await complete(input);
        assert.isTrue(built.summary.complete, JSON.stringify(built.errors).slice(0, 300));
        const classes = built.actor.items.filter(i => i.type === "class");
        assert.deepEqual(classes.map(c => [c.system.identifier, c.system.levels]).sort(), [["fighter", 3], ["wizard", 2]]);
        assert.ok(steps.some(s => s.path[0] === "multiclass:wizard"), "the Wizard's steps root at multiclass:wizard");
        const wizHp = steps.find(s => (s.path[0] === "multiclass:wizard") && (s.data?.[1] !== undefined));
        assert.equal(wizHp?.data?.[1], "avg", "the Wizard's first level is not the maximum: it isn't the first class");
        // dnd5e's multiclass rule: the secondary class grants no saving throws of its own.
        const saves = Object.entries(built.actor.system.abilities).filter(([, a]) => a.proficient).map(([k]) => k).sort();
        assert.deepEqual(saves, ["con", "str"], "the Fighter's saves only");
        const r = await replay(input, steps);
        assert.deepEqual(codes(r), [], JSON.stringify(r.errors).slice(0, 300));
        assert.deepEqual(S.differences(S.snapshot(r.actor), S.snapshot(built.actor)), []);
        assert.equal(r.actor.system.details.level, 5);
      });

      it("an ASI taken as a feat (D36): offered from dnd5e's rule, applied, and a feat not on offer is refused", async function() {
        this.timeout(300_000);
        const input = { picks: picksFor("Fighter"), base: BASE, level: 4 };
        const probe = await B.buildCharacter({ ...input, steps: (await complete(input)).steps }, { catalog, withOptions: true });
        const asi = probe.results.find(r => (r.type === "AbilityScoreImprovement") && (r.level === 4));
        assert.ok(asi?.options?.allowFeat, "a class ASI with points may take a feat");
        assert.isAtLeast(asi.options.feats.length, 1, "at least one feat a level-4 Fighter qualifies for");
        const feat = [...asi.options.feats].sort()[0];
        const withFeat = { ...input, answers: r => (r.key === asi.key ? { type: "feat", uuid: feat } : null) };
        const { built, steps } = await complete(withFeat);
        assert.isTrue(built.summary.complete, JSON.stringify(built.errors).slice(0, 300));
        assert.ok(built.actor.items.find(i => B.sourceOf(i) === feat), "the feat is on the character");
        const r = await replay(input, steps);
        assert.deepEqual(codes(r), []);
        const smuggled = steps.map(s => ((s.advancementId === asi.advancementId) && (s.level === 4)
          ? { ...s, data: { type: "feat", uuid: S.pick(catalog, "class", "Wizard") } } : s));
        assert.include(codes(await replay(input, smuggled)), "NOT_OFFERED");
      });

      it("spells of a level you can cast (\"available\"): 2014 Magical Secrets at Bard 10 offers up to 5th", async function() {
        this.timeout(300_000);
        if ( rules() !== "legacy" ) this.skip();
        const input = { picks: picksFor("Bard"), base: BASE, level: 10 };
        const { built } = await complete(input);
        const secrets = built.results.find(r => (r.type === "ItemChoice") && (r.title ?? "").includes("Magical Secrets") && (r.level === 10));
        assert.ok(secrets, "Magical Secrets at 10");
        const levels = new Set(secrets.options.options.map(u => catalog.get(u)?.system?.level));
        assert.isAtLeast(secrets.options.options.length, 10, "spells are on offer (they weren't before 8.2)");
        assert.ok([...levels].every(l => l <= 5), `levels offered: ${[...levels].sort()}`);
      });

      it("a build resumed from a level checkpoint equals the full one (D38)", async function() {
        this.timeout(300_000);
        const input = { picks: picksFor("Warlock"), base: BASE, level: 11 };
        const { steps } = await complete(input);
        const checkpoints = new Map();
        const full = await replay(input, steps, { onLevel: (c, cp) => checkpoints.set(c, cp) });
        assert.deepEqual(codes(full), []);
        for ( const at of [1, 5, 10] ) {
          const resumed = await replay(input, steps, { from: checkpoints.get(at) });
          assert.deepEqual(codes(resumed), [], `from ${at}`);
          assert.deepEqual(S.differences(S.snapshot(resumed.actor), S.snapshot(full.actor)), [], `from ${at}`);
          assert.equal(resumed.results.length, full.results.length, `from ${at}: every step's result is there`);
          assert.deepEqual(resumed.recipe, full.recipe, `from ${at}: the same recipe`);
        }
      });

      it("the incremental builder (D38) gives the full build's character after every kind of change", async function() {
        this.timeout(600_000);
        const R = await import("../scripts/rules/rebuild-cache.mjs");
        const input = { picks: picksFor("Fighter"), base: BASE, level: 8 };
        const { steps } = await complete(input);
        const build = R.incrementalBuilder({ catalog, withOptions: true });
        const same = async (label, next) => {
          const quick = await build(next);
          const full = await B.buildCharacter(next, { catalog, withOptions: true });
          assert.deepEqual(S.differences(S.snapshot(quick.actor), S.snapshot(full.actor)), [], label);
          assert.deepEqual(quick.recipe, full.recipe, `${label}: the recipe`);
          assert.equal(quick.results.length, full.results.length, `${label}: every step's result`);
        };
        await same("first build", { ...input, steps });
        await same("nothing changed", { ...input, steps });
        const asi = steps.find(s => (s.level === 8) && (s.data?.type === "asi"));
        if ( asi ) await same("the level-8 answer changed", { ...input, steps: steps.map(s => (s === asi ? { ...s, data: { type: "asi", assignments: { dex: 2 } } } : s)) });
        await same("an early answer dropped", { ...input, steps: steps.slice(1) });
        await same("a level fewer", { ...input, level: 7, steps });
        await same("a second class", { ...input, steps, multiclass: [{ uuid: S.pick(catalog, "class", "Rogue"), levels: 2 }] });
        await same("the scores changed", { ...input, base: { ...BASE, str: 14 }, steps });
      });

      it("a sliced build gives the same character, and an abandoned one stops", async function() {
        this.timeout(300_000);
        const input = { picks: picksFor("Cleric"), base: BASE, level: 8 };
        const { steps } = await complete(input);
        const whole = await replay(input, steps);
        const sliced = await replay(input, steps, { slice: true });
        assert.deepEqual(S.differences(S.snapshot(sliced.actor), S.snapshot(whole.actor)), []);
        const controller = new AbortController();
        const running = replay(input, steps, { slice: true, signal: controller.signal });
        setTimeout(() => controller.abort(new Error("newer change")), 30);
        let stopped = null;
        try {
          await running;
        } catch ( err ) {
          stopped = err.message;
        }
        assert.equal(stopped, "newer change");
      });

      it("the validator holds a draft to the GM's level and classes (D32, D35)", async function() {
        this.timeout(300_000);
        const at1 = await legitDraft({ ...FIXED[rules()], class: "Fighter" }, { catalog });
        assert.deepEqual((await V.validateDraft(at1, { catalog, userId: game.user.id })).errors, [], "level 1 as ever");
        const at4 = await legitDraft({ ...FIXED[rules()], class: "Fighter" }, { catalog, level: 4 });
        const refused = await V.validateDraft(at4, { catalog, userId: game.user.id });
        assert.include(refused.errors.map(e => e.code), "LEVEL_MISMATCH", "the GM starts characters at level 1");
        const ok = await V.validateDraft(at4, { catalog, userId: game.user.id, levels: { startingLevel: 4 } });
        assert.deepEqual(ok.errors, [], JSON.stringify(ok.errors).slice(0, 400));
        assert.equal(ok.built.actor.system.details.level, 4);
      });

      it("spells above level 1 (8.2b): counts, the spellbook and spell levels from the class's own data", async function() {
        this.timeout(300_000);
        const SF = await import("../scripts/rules/spell-facts.mjs");
        const input = { picks: picksFor("Wizard"), base: BASE, level: 5 };
        const { built } = await complete(input);
        const ctx = SF.spellContext(built, catalog);
        assert.equal(ctx.req.maxLevel, 3, "a level-5 Wizard casts 3rd-level spells");
        assert.equal(ctx.req.spellbook, 14, "six, then two a level (PHB)");
        assert.equal(ctx.req.cantrips, rules() === "legacy" ? 4 : 4);
        assert.isAtLeast(ctx.req.spells, 5);
        const draft = { spells: ctx.defaults, multiclassSpells: {} };
        assert.deepEqual(SF.checkDraftSpells(built, draft, { catalog }).map(e => e.code), [], "the defaults are legal");
        const third = ctx.options.leveled.find(u => ctx.options.levels.get(u) === 3);
        assert.ok(third, "3rd-level Wizard spells are on offer");
        const withThird = { ...ctx.defaults, spellbook: [...ctx.defaults.spellbook.slice(1), third] };
        withThird.spells = withThird.spells.filter(u => withThird.spellbook.includes(u));
        assert.deepEqual(SF.checkDraftSpells(built, { spells: withThird, multiclassSpells: {} }, { catalog }).map(e => e.code), [],
          "a 3rd-level spell in the book");
        const fourth = ctx.options.leveled.find(u => ctx.options.levels.get(u) === 4);
        if ( fourth ) {
          const tooHigh = { ...ctx.defaults, spellbook: [...ctx.defaults.spellbook.slice(1), fourth] };
          assert.include(SF.checkDraftSpells(built, { spells: tooHigh, multiclassSpells: {} }, { catalog }).map(e => e.code), "WRONG_LEVEL");
        }
      });

      it("a multiclassed caster chooses each class's spells on its own (PHB multiclassing)", async function() {
        this.timeout(300_000);
        const SF = await import("../scripts/rules/spell-facts.mjs");
        const wizard = S.pick(catalog, "class", "Wizard");
        const input = { picks: picksFor("Cleric"), base: BASE, level: 5, multiclass: [{ uuid: wizard, levels: 2 }] };
        const { built } = await complete(input);
        assert.deepEqual(SF.classRoots(built), ["class", "multiclass:wizard"]);
        const cleric = SF.spellContext(built, catalog);
        const clericPicks = new Set([...cleric.defaults.cantrips, ...cleric.defaults.spells, ...cleric.defaults.spellbook]);
        const wiz = SF.spellContext(built, catalog, "multiclass:wizard", { exclude: clericPicks });
        assert.equal(cleric.req.maxLevel, 2, "Cleric 3 on its own casts 2nd level");
        assert.equal(wiz.req.maxLevel, 1, "Wizard 2 on its own casts 1st, though the shared slots go higher");
        assert.equal(wiz.req.spellbook, 8);
        const draft = { spells: cleric.defaults, multiclassSpells: { "multiclass:wizard": wiz.defaults } };
        assert.deepEqual(SF.checkDraftSpells(built, draft, { catalog }).map(e => e.code), []);
        const missing = SF.checkDraftSpells(built, { spells: cleric.defaults, multiclassSpells: {} }, { catalog });
        assert.ok(missing.some(e => e.detail?.class === "multiclass:wizard"), "the Wizard's spells are asked for, by class");
        const d = await legitDraft({ ...FIXED[rules()], class: "Cleric" }, { catalog, level: 5, multiclass: [{ uuid: wizard, levels: 2 }] });
        const ok = await V.validateDraft(d, { catalog, userId: game.user.id, levels: { startingLevel: 5, multiclass: true,
          prerequisites: false } });   // WIS 10 and INT 12: neither class's 13 (D35 has its own test)
        assert.deepEqual(ok.errors, [], JSON.stringify(ok.errors).slice(0, 400));
      });

      it("every trait choice answered the way the screen offers it (the checklist's first boxes) completes", async function() {
        this.timeout(600_000);
        const C = await import("../scripts/wizard/choices-step.mjs");
        const P = await import("../scripts/wizard/picks.mjs");
        const wizard = S.pick(catalog, "class", "Wizard");
        const input = { picks: picksFor("Cleric"), base: BASE, level: 5, multiclass: [{ uuid: wizard, levels: 2 }] };
        const draft = { recipe: { steps: [] } };
        let built;
        for ( let round = 0; round < 80; round++ ) {
          built = await B.buildCharacter({ ...input, steps: draft.recipe.steps }, { catalog, withOptions: true });
          const open = built.results.find(r => r.status === "needsInput");
          if ( !open ) break;
          const widget = C.choicesModel(built, catalog, open.key).open.widget;
          let data = null;
          if ( widget?.type === "Trait" ) {
            for ( const box of widget.list.filter(o => !o.disabled && !o.checked).slice(0, widget.toPick - widget.picked) ) {
              data = C.answerData({ ...open, data }, { value: box.key }) ?? data;
            }
          } else data = S.answer(open.options);
          P.answerStep(draft, open, data ?? {});
        }
        const bad = built.results.filter(r => (r.status === "invalid") || (r.status === "needsInput"))
          .map(r => ({ item: r.item, title: r.title, at: r.at, data: r.data, errors: r.errors.map(e => e.code),
            allowed: r.options?.allowed, max: r.options?.max, choices: r.options?.choices }));
        assert.deepEqual(bad, [], JSON.stringify(bad).slice(0, 800));
      });

      it("no database writes and schema defaults untouched", () => {
        const writes = stopWatch();
        stopWatch = null;
        assert.deepEqual(writes, []);
        assert.deepEqual(S.schemaInitials(), initials);
      });
    });
  });

  /*
   * The release matrix (PLAN 8.7): every class at 3, 5, 11 and 20, and every class multiclassed at 5, completes,
   * replays strictly with no errors and gives the same character, and passes the validator. Heavy (run by name):
   * npm run test:foundry -- --batch levels-matrix
   */
  quench.registerBatch(`${MODULE_ID}.heavy.levels-matrix`, ({ describe, it, before, assert }) => {
    describe("Release matrix: every class at 3, 5, 11, 20, and multiclassed", () => {
      let B;
      let S;
      let V;
      let catalog;
      const picksFor = cls => ({ species: S.pick(catalog, "species", FIXED[rules()].species),
        background: S.pick(catalog, "background", FIXED[rules()].background), class: S.pick(catalog, "class", cls) });

      async function complete(input) {
        let steps = [];
        let built;
        for ( let round = 0; round < 120; round++ ) {
          built = await B.buildCharacter({ ...input, steps }, { catalog, withOptions: true });
          let open = built.results.filter(r => r.status === "needsInput");
          if ( !open.length ) break;
          const trait = open.find(r => r.type === "Trait");
          const choice = open.find(r => r.type === "ItemChoice");
          open = open.filter(r => ((r.type !== "Trait") || (r === trait)) && ((r.type !== "ItemChoice") || (r === choice)));
          steps = [...built.recipe.steps, ...open.map(r => ({ path: r.path, advancementId: r.advancementId, level: r.level,
            data: S.answer(r.options) }))];
        }
        return { built, steps: built.recipe.steps };
      }
      const check = async (label, input, failures) => {
        const { built, steps } = await complete(input);
        if ( !built.summary.complete ) return failures.push(`${label}: ${JSON.stringify(built.errors).slice(0, 200)}`);
        const r = await B.buildCharacter({ ...input, steps: JSON.parse(JSON.stringify(steps)) }, { catalog, fill: false });
        if ( r.errors.length ) return failures.push(`${label} replay: ${r.errors.map(e => e.code)}`);
        const diff = S.differences(S.snapshot(r.actor), S.snapshot(built.actor));
        if ( diff.length ) return failures.push(`${label} differs: ${JSON.stringify(diff.slice(0, 2)).slice(0, 200)}`);
        if ( r.actor.system.details.level !== input.level ) failures.push(`${label}: level ${r.actor.system.details.level}`);
      };

      before(async function() {
        this.timeout(60_000);
        B = await import("../scripts/rules/build.mjs");
        S = await import("./support.mjs");
        V = await import("../scripts/rules/validate.mjs");
        catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
      });

      it("every class at 3, 5, 11 and 20", async function() {
        this.timeout(3_600_000);
        const failures = [];
        for ( const cls of catalog.byCategory.class ) {
          for ( const level of [3, 5, 11, 20] ) await check(`${cls.name} ${level}`, { picks: picksFor(cls.name), base: BASE, level }, failures);
        }
        assert.deepEqual(failures, []);
      });

      it("every class with a second class at 5 (3 + 2), the second one each in turn", async function() {
        this.timeout(3_600_000);
        const failures = [];
        const classes = catalog.byCategory.class;
        for ( const [i, cls] of classes.entries() ) {
          const second = classes[(i + 1) % classes.length];
          await check(`${cls.name} 3 / ${second.name} 2`, { picks: picksFor(cls.name), base: BASE, level: 5,
            multiclass: [{ uuid: S.pick(catalog, "class", second.name), levels: 2 }] }, failures);
        }
        assert.deepEqual(failures, []);
      });

      it("a level-8 character of every class passes the validator", async function() {
        this.timeout(3_600_000);
        const failures = [];
        for ( const cls of catalog.byCategory.class ) {
          const d = await legitDraft({ ...FIXED[rules()], class: cls.name }, { catalog, level: 8 });
          const res = await V.validateDraft(d, { catalog, userId: game.user.id, levels: { startingLevel: 8 } });
          if ( !res.ok ) failures.push(`${cls.name}: ${res.errors.map(e => e.code).join(",")}`);
        }
        assert.deepEqual(failures, []);
      });
    });
  });
}

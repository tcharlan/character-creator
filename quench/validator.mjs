import { MODULE_ID } from "../scripts/main.mjs";
import { createDraft } from "../scripts/contracts.mjs";
import { ABILITY_TEST_QUERIES } from "./abilities.mjs";

/*
 * The validator (PLAN 2.6): complete, legitimate drafts pass for every class in both rule sets, and each
 * wizard step has a tampered case rejected with the right code and step. `validator@gm` runs it on the GM
 * for the player's draft (the player's catalog view, their chat rolls).
 */

const BASE = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };
const FIXED = {
  legacy: { species: "High Elf", background: "Acolyte", class: "Wizard" },
  modern: { species: "Human", background: "Sage", class: "Cleric" }
};
const VALIDATE = `${MODULE_ID}.test.validateDraft`;

/** Test-only GM query: validate the sender's draft as the submit handler will (PLAN 2.7). */
export function registerValidatorTestQueries() {
  CONFIG.queries[VALIDATE] = async ({ draft, image = null }, { user }) => {
    if ( !game.user.isGM || !game.users.activeGM?.isSelf ) throw new Error("Only the active GM");
    const { getCatalog } = await import("../scripts/catalog/catalog.mjs");
    const { validateDraft } = await import("../scripts/rules/validate.mjs");
    const catalog = await getCatalog({ user });
    const t0 = performance.now();
    const res = await validateDraft(draft, { catalog, userId: user.id, image });
    return { ok: res.ok, errors: res.errors, byStep: res.byStep, ms: Math.round(performance.now() - t0),
      items: res.built?.actor.items.size ?? 0, equipment: res.equipment?.items.length ?? 0 };
  };
}

/**
 * A complete, legitimate draft built the way the wizard will: the stand-in player completes the recipe,
 * then default equipment for both sources and default spells, standard array, a name.
 */
export async function legitDraft(spec, { catalog, base = BASE } = {}) {
  const B = await import("../scripts/rules/build.mjs");
  const S = await import("./support.mjs");
  const EQ = await import("../scripts/rules/equipment-items.mjs");
  const core = await import("../scripts/rules/equipment.mjs");
  const SF = await import("../scripts/rules/spell-facts.mjs");
  const rules = game.settings.get("dnd5e", "rulesVersion");
  const picks = { species: S.pick(catalog, "species", spec.species), background: S.pick(catalog, "background", spec.background),
    class: S.pick(catalog, "class", spec.class) };
  const { built, steps } = await S.complete(B.buildCharacter, { picks, base }, catalog);
  const d = createDraft({ id: foundry.utils.randomID(), worldId: game.world.id, rules });
  d.picks = picks;
  d.abilities = { method: "standardArray", base: { ...base }, roll: null };
  d.recipe = { steps: JSON.parse(JSON.stringify(steps)) };
  for ( const role of ["class", "background"] ) {
    const ctx = await EQ.equipmentContext(built.actor, built.actor.items.get(built.roots[role]), catalog);
    d.equipment[role] = core.defaultSelection(ctx.tree, ctx);
  }
  d.spells = SF.spellContext(built, catalog).defaults;
  d.details.name = `${spec.species} ${spec.class}`;
  return d;
}

export function registerValidatorBatches(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.validator`, ({ describe, it, before, assert }) => {
    describe("Validator (scripts/rules/validate.mjs), as Player A", () => {
      let V;
      let C;
      let catalog;
      let draft;
      const validate = (d, opts = {}) => V.validateDraft(d, { catalog, userId: game.user.id, ...opts });
      const tamper = async (mutate, opts) => {
        const d = foundry.utils.deepClone(draft);
        mutate(d);
        return validate(d, opts);
      };
      const firstStep = res => res.byStep[0]?.step;
      const codes = res => res.errors.map(e => e.code);

      before(async function() {
        this.timeout(120_000);
        V = await import("../scripts/rules/validate.mjs");
        C = await import("../scripts/catalog/catalog.mjs");
        catalog = await C.getCatalog();
        draft = await legitDraft(FIXED[rules()], { catalog });
      });

      it("every class: a complete, legitimate draft passes", async function() {
        this.timeout(600_000);
        const report = [];
        for ( const cls of catalog.byCategory.class ) {
          const d = await legitDraft({ ...FIXED[rules()], class: cls.name }, { catalog });
          const t0 = performance.now();
          const res = await validate(d);
          assert.deepEqual(res.errors, [], cls.name);
          assert.isTrue(res.ok);
          report.push(`${cls.name} ${Math.round(performance.now() - t0)}ms ${res.built.actor.items.size}it ${res.equipment.items.length}eq`);
        }
        console.log(`${MODULE_ID} | validator (${rules()}): ${report.join(", ")}`);
      });
      it("every species and background: a complete, legitimate draft passes", async function() {
        this.timeout(600_000);
        for ( const sp of catalog.byCategory.species ) {
          assert.deepEqual((await validate(await legitDraft({ ...FIXED[rules()], species: sp.name }, { catalog }))).errors, [], sp.name);
        }
        for ( const bg of catalog.byCategory.background ) {
          assert.deepEqual((await validate(await legitDraft({ ...FIXED[rules()], background: bg.name }, { catalog }))).errors, [], bg.name);
        }
      });

      // One tampered case per wizard step: [step, expected code (or "A|B"), mutate, options?].
      const CASES = [
        ["start", "BAD_REQUEST", d => d.picks = "nope"],
        ["start", "WORLD_MISMATCH", d => d.worldId = "another-world"],
        ["start", "RULES_MISMATCH", d => d.rules = d.rules === "legacy" ? "modern" : "legacy"],
        ["start", "SCHEMA_TOO_NEW", d => d.schema += 1],
        ["start", "CHARACTER_LIMIT", () => {}, { characters: { limit: 1, existing: 1 } }],
        ["species", "SPECIES_MISSING", d => d.picks.species = null],
        ["class", "CLASS_MISSING", d => d.picks.class = null],
        ["background", "BACKGROUND_MISSING", d => d.picks.background = null],
        ["abilities", "POINT_BUY_INVALID", d => d.abilities = { method: "pointBuy", base: { ...BASE, cha: 9 }, roll: null }],
        ["abilities", "STANDARD_ARRAY_INVALID", d => d.abilities.base.cha = 15],
        ["abilities", "ABILITY_METHOD_NOT_ALLOWED", () => {}, { allowedMethods: ["pointBuy"] }],
        ["abilities", "ABILITY_SCORES_MISSING", d => d.abilities = { method: "rolled", base: BASE, roll: null }],
        ["abilities", "ABILITY_METHOD_MISSING", d => d.abilities.method = null],
        ["choices", "MISSING_STEP", d => d.recipe.steps.pop()],
        ["choices", "UNKNOWN_ADVANCEMENT", d => d.recipe.steps.push({ ...d.recipe.steps[0], advancementId: "ZZZZZZZZZZZZZZZZ" })],
        // A blank selection: an OR without a choice, or a category without picks (2024 Cleric has only the latter).
        ["equipment", "MISSING_CHOICE|WRONG_PICK_COUNT", d => d.equipment.class = { mode: "items", choices: {}, picks: {} }],
        ["equipment", "UNEXPECTED_SELECTION", d => d.equipment.background.choices.ZZZZZZZZZZZZZZZZ = "YYYYYYYYYYYYYYYY"],
        ["spells", "CANTRIP_COUNT", d => d.spells.cantrips.pop()],
        ["details", "NAME_REQUIRED", d => d.details.name = " "],
        ["portrait", "BAD_IMAGE", () => {}, { image: { mime: "image/png", data: "AAAA", width: 10, height: 10 } }]
      ];
      for ( const [step, code, mutate, opts] of CASES ) {
        it(`${step}: ${code} is rejected, pointing at the ${step} step`, async function() {
          this.timeout(60_000);
          const res = await tamper(mutate, opts);
          assert.isFalse(res.ok);
          const wanted = code.split("|");
          assert.isTrue(codes(res).some(c => wanted.includes(c)), JSON.stringify(res.errors).slice(0, 400));
          const group = res.byStep.find(g => g.errors.some(e => wanted.includes(e.code)));
          assert.equal(group?.step, step);
          // Envelope errors stop validation; the others are reported alongside the step's own.
          if ( step === "start" && code !== "CHARACTER_LIMIT" ) assert.equal(firstStep(res), "start");
        });
      }

      it("a class the GM disallows is rejected at the class step (and everything else still reported)", async function() {
        this.timeout(60_000);
        const others = catalog.byCategory.class.filter(e => e.name !== FIXED[rules()].class).map(e => e.uuid);
        const narrowed = await C.getCatalog({ restrictions: { packs: null, categories: { class: others } } });
        const res = await validate(draft, { catalog: narrowed });
        assert.include(codes(res), "CLASS_NOT_ALLOWED");
        assert.equal(res.byStep.find(g => g.errors.some(e => e.code === "CLASS_NOT_ALLOWED")).step, "class");
      });
      it("a duplicated cantrip is rejected at the spells step", async () => {
        const res = await tamper(d => d.spells.cantrips[0] = d.spells.cantrips[1]);
        assert.includeMembers(codes(res), ["DUPLICATE"]);
        assert.equal(res.byStep.at(-1).step, "spells");
      });
      it("the validator reads only the recipe: a draft with a tampered result or status is judged on its recipe", async () => {
        const res = await tamper(d => {
          d.result = { actorUuid: null, errors: [] };
          d.step = "review";
        });
        assert.deepEqual(res.errors, []);
      });
    });
  }, { displayName: "Character Creator: Validator" });

  quench.registerBatch(`${MODULE_ID}.validator@gm`, ({ describe, it, before, after, assert }) => {
    describe("Validator on the GM, for the player's draft", () => {
      let catalog;
      let draft;
      const draftIds = [];
      const query = data => game.users.activeGM.query(VALIDATE, data, { timeout: 120_000 });

      before(async function() {
        this.timeout(120_000);
        assert.isFalse(game.user.isGM, "run as a player");
        assert.exists(game.users.activeGM, "no active GM — run with npm run test:foundry");
        catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        draft = await legitDraft(FIXED[rules()], { catalog });
        draftIds.push(draft.id);
      });
      after(async function() {
        this.timeout(30_000);
        if ( game.users.activeGM ) await game.users.activeGM.query(ABILITY_TEST_QUERIES.CLEANUP, { draftIds }, { timeout: 30_000 });
      });

      it("the GM accepts the player's legitimate draft (player's catalog view)", async function() {
        this.timeout(120_000);
        const res = await query({ draft });
        assert.deepEqual(res.errors, []);
        assert.isTrue(res.ok);
        assert.isAbove(res.items, 0);
        console.log(`${MODULE_ID} | validator@gm (${rules()}): ${res.ms} ms, ${res.items} items, ${res.equipment} equipment lines`);
      });
      it("rolled ability scores: the GM accepts the chat roll, and rejects edited results", async function() {
        this.timeout(120_000);
        const { rollAbilityScores } = await import("../scripts/rules/ability-roll.mjs");
        const d = foundry.utils.deepClone(draft);
        d.id = foundry.utils.randomID();
        draftIds.push(d.id);
        const roll = await rollAbilityScores(d);
        const r = roll.results;
        d.abilities = { method: "rolled", base: { str: r[0], dex: r[1], con: r[2], int: r[3], wis: r[4], cha: r[5] }, roll };
        // Different base scores can change the recipe (e.g. prepared counts): rebuild the legit parts.
        const fresh = await legitDraft(FIXED[rules()], { catalog, base: d.abilities.base });
        Object.assign(d, { recipe: fresh.recipe, equipment: fresh.equipment, spells: fresh.spells });
        assert.deepEqual((await query({ draft: d })).errors, []);
        d.abilities.roll.results = r.map((v, i) => (i ? v : (v === 18 ? 17 : v + 1)));
        d.abilities.base.str = d.abilities.roll.results[0];
        assert.deepEqual((await query({ draft: d })).errors.map(e => e.code), ["ROLL_INVALID"]);
      });
      it("2014 rolled starting gold: accepted from chat, rejected when edited", async function() {
        if ( rules() !== "legacy" ) this.skip();
        this.timeout(120_000);
        const EQ = await import("../scripts/rules/equipment-items.mjs");
        const B = await import("../scripts/rules/build.mjs");
        const d = foundry.utils.deepClone(draft);
        d.id = foundry.utils.randomID();
        draftIds.push(d.id);
        const built = await B.buildCharacter({ picks: d.picks, base: d.abilities.base, steps: d.recipe.steps }, { catalog });
        const wealth = built.actor.items.get(built.roots.class).system.wealth;
        d.equipment.class = { mode: "wealth", choices: {}, picks: {}, wealth: await EQ.rollStartingWealth(d, "class", wealth) };
        assert.deepEqual((await query({ draft: d })).errors, []);
        d.equipment.class.wealth.total += d.equipment.class.wealth.total >= 200 ? -10 : 10;
        assert.include((await query({ draft: d })).errors.map(e => e.code), "WEALTH_ROLL_INVALID");
      });
      it("a portrait sent with the submission is checked on the GM", async function() {
        this.timeout(60_000);
        const res = await query({ draft, image: { mime: "image/webp", data: "AAAA", width: 4096, height: 10 } });
        assert.deepEqual(res.errors.map(e => e.code), ["BAD_IMAGE"]);
      });
    });
  }, { displayName: "Character Creator: Validator on the GM" });
}

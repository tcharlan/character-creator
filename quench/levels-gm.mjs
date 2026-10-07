import { MODULE_ID } from "../scripts/main.mjs";
import { QUERIES } from "../scripts/contracts.mjs";
import { SUBMIT_TEST_QUERIES } from "./submit.mjs";
import { SETTINGS_TEST_QUERIES } from "./settings.mjs";
import { ABILITY_TEST_QUERIES } from "./abilities.mjs";
import { legitDraft } from "./validator.mjs";

/*
 * The GM's settings above level 1 (PLAN 8.3; D32–D35), end to end: the player submits, the GM's browser checks
 * the draft against the starting level, multiclassing and its prerequisites, and the hit point method, and
 * creates the character with the gold for its levels. Every setting is restored after.
 */

const FIXED = {
  legacy: { species: "Hill Dwarf", background: "Acolyte" },
  modern: { species: "Human", background: "Sage" }
};
const Q = SETTINGS_TEST_QUERIES;

export function registerLevelsGmBatches(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.levels@gm`, ({ describe, it, before, after, afterEach, assert }) => {
    describe("Above level 1: the GM's settings, checked and applied on the GM's side", () => {
      let catalog;
      const touched = new Set();
      const draftIds = [];
      const gm = () => game.users.activeGM;
      const query = (name, data) => gm().query(name, data, { timeout: 180_000 });
      const set = async (key, value) => {
        touched.add(key);
        await query(Q.SET, { key, value });
        for ( let i = 0; i < 40 && JSON.stringify(game.settings.get(MODULE_ID, key)) !== JSON.stringify(value); i++ ) {
          await new Promise(r => setTimeout(r, 100));
        }
      };
      const submit = draft => query(QUERIES.SUBMIT, { draft });
      const draft = async (cls, options = {}) => {
        const d = await legitDraft({ ...FIXED[rules()], class: cls }, { catalog, ...options });
        draftIds.push(d.id);
        return d;
      };
      const codes = res => (res.errors ?? []).map(e => e.code);
      const cleanup = () => query(SUBMIT_TEST_QUERIES.CLEANUP, {});

      before(async function() {
        this.timeout(120_000);
        assert.isFalse(game.user.isGM, "run as a player");
        assert.exists(gm(), "no active GM — run with npm run test:foundry");
        catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        await cleanup();
        await set("characterLimit", 0);
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
        await query(ABILITY_TEST_QUERIES.CLEANUP, { draftIds });
      });

      it("starting level (D32): a draft at another level is sent back; one at the GM's is created at it, with its gold (D34)", async function() {
        this.timeout(300_000);
        await set("startingLevel", 4);
        await set("goldPerLevel", 100);
        assert.include(codes(await submit(await draft("Fighter"))), "LEVEL_MISMATCH", "a level-1 draft");
        const res = await submit(await draft("Fighter", { level: 4 }));
        assert.isTrue(res.ok, JSON.stringify(res.errors ?? []).slice(0, 400));
        const actor = await fromUuid(res.actorUuid);
        assert.equal(actor.system.details.level, 4);
        const fighter = actor.items.find(i => i.type === "class");
        assert.equal(fighter.system.levels, 4);
        const con = actor.system.abilities.con.mod;
        assert.equal(actor.system.attributes.hp.max, (10 + con) + (3 * (6 + con)), "the maximum, then the average (D33)");
        assert.equal(actor.system.attributes.hp.value, actor.system.attributes.hp.max, "starts at full hit points");
        assert.isAtLeast(actor.system.currency.gp, 300, "100 gp for each of three levels above the first");
      });

      it("hit points rolled (D33): a draft carrying the average is refused", async function() {
        this.timeout(300_000);
        await set("startingLevel", 3);
        await set("hitPointMethod", "rolled");
        try {
        const res = await submit(await draft("Fighter", { level: 3 }));
        assert.isFalse(res.ok);
        assert.include(codes(res), "NOT_ALLOWED");

        // Rolled the way the wizard rolls them: the missing hit dice, posted to chat, then the replay takes them.
        const B = await import("../scripts/rules/build.mjs");
        const HP = await import("../scripts/rules/hit-points.mjs");
        const d = await draft("Fighter", { level: 3 });
        const first = await B.buildCharacter(B.buildInput(d), { catalog, fill: true, hitPointMethod: "rolled" });
        const needs = HP.slotsToRoll(first);
        assert.deepEqual(needs.map(n => n.slot), ["fighter@2", "fighter@3"], "two hit dice to roll");
        d.hitPoints = { rolls: await HP.rollHitPoints(d, needs) };
        const again = await HP.rollHitPoints(d, needs);
        assert.deepEqual(again, {}, "a slot is never rolled twice");
        const built = await B.buildCharacter(B.buildInput(d), { catalog, fill: true, hitPointMethod: "rolled" });
        const hpKeys = new Set(built.results.filter(r => r.type === "HitPoints").map(r => r.key));
        const P = await import("../scripts/rules/paths.mjs");
        d.recipe.steps = [...d.recipe.steps.filter(s => !hpKeys.has(P.stepKey(s))),
          ...built.recipe.steps.filter(s => hpKeys.has(P.stepKey(s)))];
        const ok = await submit(d);
        assert.isTrue(ok.ok, JSON.stringify(ok.errors ?? []).slice(0, 400));
        const actor = await fromUuid(ok.actorUuid);
        const con = actor.system.abilities.con.mod;
        const rolled = d.hitPoints.rolls["fighter@2"].total + d.hitPoints.rolls["fighter@3"].total;
        assert.equal(actor.system.attributes.hp.max, 10 + rolled + (3 * con), "the maximum, then the dice");
        await cleanup();

        // The same draft claiming a better roll than chat shows is refused.
        const tampered = foundry.utils.deepClone(d);
        tampered.id = foundry.utils.randomID();
        draftIds.push(tampered.id);
        assert.include(codes(await submit(tampered)), "HIT_POINTS_ROLL_INVALID", "another draft's rolls");
        } finally {
          await set("hitPointMethod", "average");
        }
      });

      it("multiclassing (D35): off, refused; on, held to the prerequisites unless the GM waives them", async function() {
        this.timeout(300_000);
        await set("startingLevel", 5);
        const monk = (await import("./support.mjs")).pick(catalog, "class", "Monk");
        const multi = () => draft("Fighter", { level: 5, multiclass: [{ uuid: monk, levels: 2 }] });
        await set("multiclass", false);
        assert.include(codes(await submit(await multi())), "MULTICLASS_NOT_ALLOWED");
        await set("multiclass", true);
        await set("multiclassPrerequisites", true);
        const refused = await submit(await multi());
        assert.include(codes(refused), "MULTICLASS_PREREQUISITES",
          "a Monk needs DEX 13 and WIS 13: WIS is at most 11 with these scores in either rule set");
        await set("multiclassPrerequisites", false);
        const res = await submit(await multi());
        assert.isTrue(res.ok, JSON.stringify(res.errors ?? []).slice(0, 400));
        const actor = await fromUuid(res.actorUuid);
        assert.deepEqual(actor.items.filter(i => i.type === "class").map(c => [c.system.identifier, c.system.levels]).sort(),
          [["fighter", 3], ["monk", 2]]);
        assert.equal(actor.system.details.level, 5);
        assert.equal(actor.system.details.originalClass, actor.items.find(i => i.system.identifier === "fighter")?.id,
          "the first class stays the original one");
      });
    });
  });
}

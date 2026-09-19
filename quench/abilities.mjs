import { MODULE_ID } from "../scripts/main.mjs";
import { createDraft } from "../scripts/contracts.mjs";
import { rollAbilityScores, checkDraftAbilities, readRollRecord } from "../scripts/rules/ability-roll.mjs";
import { checkRollRecord, ROLL_FLAG, EDIT_TOLERANCE_MS } from "../scripts/rules/abilities.mjs";

/*
 * Ability score methods (PLAN 2.4): Player A rolls in their browser and posts to chat (D15); the GM checks
 * the draft against the chat record, as the validator will (2.6).
 */

/** Test-only GM queries; CLEANUP deletes every roll message flagged with the given draft ids. */
export const ABILITY_TEST_QUERIES = Object.freeze({
  CHECK: `${MODULE_ID}.test.checkAbilities`,
  GM_ROLL: `${MODULE_ID}.test.gmAbilityRoll`,
  CLEANUP: `${MODULE_ID}.test.abilityRollCleanup`
});
const Q = ABILITY_TEST_QUERIES;

export function registerAbilityTestQueries() {
  const gmOnly = () => {
    if ( !game.user.isGM || !game.users.activeGM?.isSelf ) throw new Error("Only the active GM");
  };
  // The GM validates a draft for the player who sent it.
  CONFIG.queries[Q.CHECK] = async ({ draft }, { user }) => {
    gmOnly();
    return checkDraftAbilities(draft, { userId: user.id });
  };
  // A roll posted by the GM (someone other than the draft's owner).
  CONFIG.queries[Q.GM_ROLL] = async ({ draftId }) => {
    gmOnly();
    return rollAbilityScores({ id: draftId, abilities: { roll: null } });
  };
  CONFIG.queries[Q.CLEANUP] = async ({ draftIds }) => {
    gmOnly();
    const ids = game.messages.filter(m => draftIds.includes(m.getFlag(MODULE_ID, ROLL_FLAG)?.draftId)).map(m => m.id);
    await ChatMessage.implementation.deleteDocuments(ids);
    return ids.length;
  };
}

export function registerAbilityBatches(quench) {
  quench.registerBatch(`${MODULE_ID}.abilities@gm`, ({ describe, it, before, after, assert }) => {
    describe("Ability scores (PLAN 2.4): rolled in the player's browser, checked by the GM", () => {
      const draftIds = [];
      const query = (name, data) => game.users.activeGM.query(name, data, { timeout: 30_000 });
      const newDraft = () => {
        const d = createDraft({ id: foundry.utils.randomID(), worldId: game.world.id, rules: game.settings.get("dnd5e", "rulesVersion") });
        draftIds.push(d.id);
        return d;
      };
      const assign = results => ({ str: results[5], dex: results[4], con: results[3], int: results[2], wis: results[1], cha: results[0] });
      /** A draft with a fresh roll, scores assigned from it (reversed, to show order is free). */
      const rolledDraft = async () => {
        const d = newDraft();
        const roll = await rollAbilityScores(d);
        d.abilities = { method: "rolled", base: assign(roll.results), roll };
        return d;
      };
      const check = draft => query(Q.CHECK, { draft });
      const why = errs => errs.map(e => `${e.code}:${e.detail?.message ?? Object.keys(e.detail ?? {})[0]}`);

      before(function() {
        assert.isFalse(game.user.isGM, "run as a player");
        assert.exists(game.users.activeGM, "no active GM — run with npm run test:foundry");
      });
      after(async function() {
        this.timeout(30_000);
        if ( game.users.activeGM && draftIds.length ) await query(Q.CLEANUP, { draftIds });
      });

      it("the player's roll posts one public chat message with six 4d6kh3 rolls, flagged for the draft", async () => {
        const d = newDraft();
        const { messageId, results } = await rollAbilityScores(d);
        const m = game.messages.get(messageId);
        assert.exists(m);
        assert.equal(m.author.id, game.user.id);
        assert.lengthOf(m.whisper, 0);
        assert.isFalse(m.blind);
        assert.deepEqual(m.getFlag(MODULE_ID, ROLL_FLAG), { draftId: d.id, purpose: "abilities" });
        assert.deepEqual(m.rolls.map(r => r.formula), Array(6).fill("4d6kh3"));
        assert.deepEqual(m.rolls.map(r => r.total), results);
        for ( const v of results ) assert.isTrue(v >= 3 && v <= 18);
        // Real Foundry dice read back as a consistent record (active/discarded mapping, created = modified).
        const rec = readRollRecord(m);
        assert.isAtMost(rec.modified - rec.created, EDIT_TOLERANCE_MS, "a new message is stamped once");
        assert.deepEqual(checkRollRecord(rec, { draftId: d.id, userId: game.user.id, results }), []);
        console.log(`${MODULE_ID} | abilities roll: stamp gap ${rec.modified - rec.created} ms, ${JSON.stringify(results)} dice ${JSON.stringify(rec.rolls[0].dice[0].results)}`);
      });

      it("refuses to roll again for a draft that already holds a roll (A10)", async () => {
        const d = await rolledDraft();
        let err;
        try { await rollAbilityScores(d); } catch ( e ) { err = e; }
        assert.equal(err?.code, "ROLL_INVALID");
      });

      it("the GM accepts an untouched roll, assigned in any order", async () => {
        const d = await rolledDraft();
        assert.deepEqual(await check(d), []);
      });

      it("the GM rejects edited results in the draft", async () => {
        const d = await rolledDraft();
        const r = [...d.abilities.roll.results];
        r[0] = r[0] === 18 ? 17 : r[0] + 1;
        d.abilities.roll.results = r;
        d.abilities.base = assign(r);
        assert.deepEqual(why(await check(d)), ["ROLL_INVALID:resultsDiffer"]);
      });

      it("the GM rejects a message the player edited after rolling", async () => {
        const d = await rolledDraft();
        await new Promise(r => setTimeout(r, EDIT_TOLERANCE_MS + 200));
        await game.messages.get(d.abilities.roll.messageId).update({ flavor: "edited" });
        assert.deepEqual(why(await check(d)), ["ROLL_INVALID:edited"]);
      });

      it("the GM rejects a roll posted by another user", async () => {
        const d = newDraft();
        const roll = await query(Q.GM_ROLL, { draftId: d.id });
        d.abilities = { method: "rolled", base: assign(roll.results), roll };
        assert.deepEqual(why(await check(d)), ["ROLL_INVALID:wrongAuthor"]);
      });

      it("the GM rejects a roll made for a different draft", async () => {
        const other = await rolledDraft();
        const d = newDraft();
        d.abilities = foundry.utils.deepClone(other.abilities);
        assert.deepEqual(why(await check(d)), ["ROLL_INVALID:wrongDraft"]);
      });

      it("the GM rejects a missing message", async () => {
        const d = await rolledDraft();
        d.abilities.roll.messageId = foundry.utils.randomID();
        assert.deepEqual(why(await check(d)), ["ROLL_INVALID:missing"]);
      });

      it("the GM rejects a re-roll: two rolls on record for one draft", async () => {
        const d = await rolledDraft();
        const second = await rollAbilityScores({ id: d.id, abilities: { roll: null } });   // bypassing the wizard's lock
        d.abilities = { method: "rolled", base: assign(second.results), roll: second };
        assert.deepEqual(why(await check(d)), ["ROLL_INVALID:rerolled"]);
      });

      it("the GM rejects switching method after rolling, even with the roll removed from the draft", async () => {
        const d = await rolledDraft();
        d.abilities = { method: "standardArray", base: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, roll: null };
        assert.deepEqual(why(await check(d)), ["ROLL_INVALID:rolledButMethod"]);
      });

      it("point buy and standard array need no chat record", async () => {
        const pb = newDraft();
        pb.abilities = { method: "pointBuy", base: { str: 15, dex: 15, con: 15, int: 8, wis: 8, cha: 8 }, roll: null };
        assert.deepEqual(await check(pb), []);
        pb.abilities.base.int = 9;
        assert.deepEqual(why(await check(pb)), ["POINT_BUY_INVALID:spent"]);
        const sa = newDraft();
        sa.abilities = { method: "standardArray", base: { str: 8, dex: 10, con: 12, int: 13, wis: 14, cha: 15 }, roll: null };
        assert.deepEqual(await check(sa), []);
      });
    });
  }, { displayName: "Character Creator: Ability scores" });
}

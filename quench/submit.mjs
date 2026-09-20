import { MODULE_ID } from "../scripts/main.mjs";
import { QUERIES } from "../scripts/contracts.mjs";
import { ABILITY_TEST_QUERIES } from "./abilities.mjs";
import { legitDraft } from "./validator.mjs";

/*
 * GM side (PLAN 2.7): Player A submits through the real `character-creator.submit` query; the Gamemaster's
 * client validates and creates. Covers creation ≡ the validated rebuild, ownership and assignment, the
 * portrait, idempotency, the in-flight lock, rejection with nothing created, the character limit (A4) and
 * the post-creation portrait upload (A5).
 */

const FIXED = {
  legacy: { species: "High Elf", background: "Acolyte", class: "Wizard" },
  modern: { species: "Human", background: "Sage", class: "Cleric" }
};
/** Test-only GM queries; CLEANUP deletes the sender's created characters and clears the assignment. */
export const SUBMIT_TEST_QUERIES = Object.freeze({
  CLEANUP: `${MODULE_ID}.test.submitCleanup`,
  UNOWNED: `${MODULE_ID}.test.unownedActor`,
  GM_WINDOWS: `${MODULE_ID}.test.gmWindows`
});
const Q = SUBMIT_TEST_QUERIES;

export function registerSubmitTestQueries() {
  const gmOnly = () => {
    if ( !game.user.isGM || !game.users.activeGM?.isSelf ) throw new Error("Only the active GM");
  };
  // Delete the sender's created characters and this suite's helper actors; clear the assignment.
  CONFIG.queries[Q.CLEANUP] = async (data, { user }) => {
    gmOnly();
    const flags = a => a.flags?.[MODULE_ID] ?? {};
    const ids = game.actors.filter(a => flags(a).created?.userId === user.id || flags(a).submitTest).map(a => a.id);
    // Also let go of a character this module created in an earlier run, so the next test starts unassigned.
    if ( user.character && (ids.includes(user.character.id) || flags(user.character).created) ) {
      await user.update({ character: null });
    }
    await Actor.implementation.deleteDocuments(ids);
    return ids.length;
  };
  // Open application windows on the GM (creation must not open an AdvancementManager or sheet).
  CONFIG.queries[Q.GM_WINDOWS] = async () => {
    gmOnly();
    return [...foundry.applications.instances.values()].map(a => a.constructor.name)
      .concat(Object.values(ui.windows).map(a => a.constructor.name)).sort();
  };
  CONFIG.queries[Q.UNOWNED] = async () => {
    gmOnly();
    const actor = await Actor.implementation.create({ name: "Not yours", type: "character",
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE }, flags: { [MODULE_ID]: { submitTest: true } } });
    return actor.uuid;
  };
}

export function registerSubmitBatches(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.submit@gm`, ({ describe, it, before, after, assert }) => {
    describe("Submit: the active GM validates and creates the player's character", () => {
      let catalog;
      let draft;
      let image;
      let actor;
      let expected;
      const draftIds = [];
      const gm = () => game.users.activeGM;
      const submit = payload => gm().query(QUERIES.SUBMIT, payload, { timeout: 120_000 });
      const mine = () => game.actors.filter(a => a.getFlag(MODULE_ID, "created")?.userId === game.user.id);
      const cleanup = () => gm().query(Q.CLEANUP, {}, { timeout: 60_000 });

      before(async function() {
        this.timeout(180_000);
        assert.isFalse(game.user.isGM, "run as a player");
        assert.exists(gm(), "no active GM — run with npm run test:foundry");
        await cleanup();
        const S = await import("./support.mjs");
        const { preparePortrait } = await import("../scripts/portrait/prepare.mjs");
        catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        draft = await legitDraft(FIXED[rules()], { catalog });
        Object.assign(draft.details, { pronouns: "they/them", traits: "Curious", biography: "Line one\n\n<b>not bold</b>" });
        draft.portrait.ring = { ring: "#c9a227", background: "#1b2a49", effects: 1 };
        draftIds.push(draft.id);
        image = await preparePortrait(await S.makeTestImage(1200, 1600));
        // What the GM should create: the same validation and creation data, computed here.
        const V = await import("../scripts/rules/validate.mjs");
        const { characterData } = await import("../scripts/gm/create.mjs");
        const validated = await V.validateDraft(draft, { catalog, userId: game.user.id });
        assert.isTrue(validated.ok, JSON.stringify(validated.errors).slice(0, 300));
        expected = await characterData(validated, { user: game.user, catalog });
      });
      after(async function() {
        this.timeout(60_000);
        if ( !gm() ) return;
        await cleanup();
        await gm().query(ABILITY_TEST_QUERIES.CLEANUP, { draftIds }, { timeout: 30_000 });
      });

      it("the handler answers only on the active GM", async () => {
        const { handleSubmit } = await import("../scripts/gm/submit.mjs");
        const res = await handleSubmit({ draft }, { user: game.user });
        assert.deepEqual(res.errors.map(e => e.code), ["NOT_ACTIVE_GM"]);
      });
      it("a player cannot create an actor directly (D13: only the GM writes characters)", async () => {
        const before = game.actors.size;
        const created = await Actor.implementation.create({ name: "should not exist", type: "character" }).catch(() => null);
        assert.notExists(created);
        assert.equal(game.actors.size, before);
      });
      it("a malformed payload is rejected (BAD_REQUEST) and creates nothing", async () => {
        const res = await submit({ draft: { ...draft, picks: 42 } });
        assert.deepEqual(res.errors.map(e => e.code), ["BAD_REQUEST"]);
        assert.lengthOf(mine(), 0);
      });
      it("a tampered draft is rejected with its step, and creates nothing", async function() {
        this.timeout(120_000);
        const bad = foundry.utils.deepClone(draft);
        bad.recipe.steps.pop();
        bad.spells.cantrips.pop();
        const res = await submit({ draft: bad });
        assert.isFalse(res.ok);
        assert.includeMembers(res.errors.map(e => e.code), ["MISSING_STEP", "CANTRIP_COUNT"]);
        assert.includeMembers(res.byStep.map(g => g.step), ["choices", "spells"]);
        assert.lengthOf(mine(), 0);
      });
      it("two simultaneous submits of one draft create one character (in-flight lock)", async function() {
        this.timeout(180_000);
        const S = await import("./support.mjs");
        const windowsBefore = await gm().query(Q.GM_WINDOWS, {}, { timeout: 30_000 });
        const stop = S.watchDb();
        const t0 = performance.now();
        const [a, b] = await Promise.all([submit({ draft, image }), submit({ draft, image })]);
        const ms = Math.round(performance.now() - t0);
        const writes = stop();
        assert.isTrue(a.ok, JSON.stringify(a.errors ?? []).slice(0, 300));
        assert.equal(a.actorUuid, b.actorUuid);
        assert.deepEqual(a.warnings, []);
        assert.lengthOf(mine(), 1);
        actor = await fromUuid(a.actorUuid);
        assert.deepEqual(writes, [], "the player's own client wrote nothing");
        assert.deepEqual(await gm().query(Q.GM_WINDOWS, {}, { timeout: 30_000 }), windowsBefore, "no windows opened on the GM");
        console.log(`${MODULE_ID} | submit (${rules()}): ${ms} ms, ${actor.items.size} items`);
      });
      it("the character is exactly the validated build: items, abilities, HP, currency, details", () => {
        const names = list => list.map(i => `${i.type}:${i.name}`).sort();
        assert.deepEqual(names(actor.items.contents), names(expected.items));
        for ( const k of ["str", "dex", "con", "int", "wis", "cha"] ) {
          assert.equal(actor.system.abilities[k].value, expected.system.abilities[k].value, k);
        }
        assert.equal(actor.system.details.level, 1);
        assert.equal(actor.system.attributes.hp.value, actor.system.attributes.hp.max);
        assert.equal(actor.system.attributes.hp.max, expected.system.attributes.hp.value);
        for ( const [k, v] of Object.entries(expected.system.currency) ) assert.equal(actor.system.currency[k], v, k);
        assert.equal(actor.name, draft.details.name);
        assert.equal(actor.prototypeToken.name, draft.details.name);
        assert.equal(actor.system.details.gender, "they/them");
        assert.equal(actor.system.details.trait, "Curious");
        assert.equal(actor.system.details.biography.value, "<p>Line one</p><p>&lt;b&gt;not bold&lt;/b&gt;</p>");
        assert.deepEqual(actor.getFlag(MODULE_ID, "created").draftId, draft.id);
      });
      it("the player owns it, nobody else does, and it is their assigned character", () => {
        const L = CONST.DOCUMENT_OWNERSHIP_LEVELS;
        assert.isTrue(actor.isOwner);
        assert.equal(actor.ownership.default, L.NONE);
        assert.equal(actor.ownership[game.user.id], L.OWNER);
        assert.equal(game.user.character?.id, actor.id);
      });
      it("the portrait is saved under the actor's assets, with token and ring", () => {
        assert.match(actor.img, new RegExp(`assets/actors/${actor.id}-[^/]+\\.webp$`));
        assert.equal(actor.prototypeToken.texture.src, actor.img);
        assert.isTrue(actor.prototypeToken.ring.enabled);
        assert.equal(actor.prototypeToken.ring.colors.ring.css, "#c9a227");
        assert.equal(actor.prototypeToken.ring.subject.texture, actor.img);
      });
      it("resubmitting the draft returns the same character (idempotent)", async function() {
        this.timeout(60_000);
        const res = await submit({ draft, image });
        assert.deepEqual([res.ok, res.actorUuid, res.duplicate], [true, actor.uuid, true]);
        assert.lengthOf(mine(), 1);
      });
      it("a second character is refused at the limit (A4: one per player by default)", async function() {
        this.timeout(120_000);
        const other = await legitDraft(FIXED[rules()], { catalog });
        draftIds.push(other.id);
        const res = await submit({ draft: other });
        assert.deepEqual(res.errors.map(e => e.code), ["CHARACTER_LIMIT"]);
        assert.lengthOf(mine(), 1);
      });
      it("uploading a new portrait later (A5): own actor yes; missing or not-owned actor no", async function() {
        this.timeout(120_000);
        const up = payload => gm().query(QUERIES.UPLOAD_PORTRAIT, payload, { timeout: 60_000 });
        const before = actor.img;
        const res = await up({ actorUuid: actor.uuid, image, ring: { ring: "#336699", background: null, effects: 1 } });
        assert.isTrue(res.ok, JSON.stringify(res));
        assert.notEqual(res.path, before, "a new file name (no stale cache)");
        assert.equal(actor.img, res.path);
        const missing = await up({ actorUuid: `Actor.${foundry.utils.randomID()}`, image });
        assert.deepEqual(missing.errors.map(e => e.code), ["NO_ACTOR"]);
        const unowned = await gm().query(Q.UNOWNED, {}, { timeout: 30_000 });
        const refused = await up({ actorUuid: unowned, image });
        assert.deepEqual(refused.errors.map(e => e.code), ["NOT_OWNER"]);
        const tampered = await up({ actorUuid: actor.uuid, image: { ...image, width: image.width + 1 } });
        assert.deepEqual(tampered.errors.map(e => e.code), ["BAD_IMAGE"]);
      });
      it("a portrait that passes the payload check but not the GM's decode is a warning; the character is created", async function() {
        this.timeout(120_000);
        await cleanup();
        const other = foundry.utils.deepClone(draft);
        other.id = foundry.utils.randomID();
        draftIds.push(other.id);
        // Well-formed base64 and dimensions, but not a WebP file.
        const res = await submit({ draft: other, image: { mime: "image/webp", data: btoa("not a webp file at all"), width: 10, height: 10 } });
        assert.isTrue(res.ok, JSON.stringify(res.errors ?? []).slice(0, 300));
        assert.deepEqual(res.warnings.map(e => e.code), ["BAD_IMAGE"]);
        const created = await fromUuid(res.actorUuid);
        assert.notInclude(created.img, "assets/actors");
      });
      it("clean-up deletes the character and clears the assignment", async function() {
        this.timeout(60_000);
        await cleanup();
        assert.lengthOf(mine(), 0);
        assert.notExists(game.user.character);
      });
    });
  }, { displayName: "Character Creator: Submit (GM side)" });
}

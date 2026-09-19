import { MODULE_ID } from "../scripts/main.mjs";
import { QUERIES } from "../scripts/contracts.mjs";
import { SUBMIT_TEST_QUERIES } from "./submit.mjs";
import { SETTINGS_TEST_QUERIES } from "./settings.mjs";
import { ABILITY_TEST_QUERIES } from "./abilities.mjs";
import { legitDraft } from "./validator.mjs";

/*
 * Phase 2 "Done when" (PLAN.md): Player A submits a build for every SRD class through the real submit query,
 * and the GM creates a correct actor for each — the same items (and which container each one is in),
 * abilities, HP, currency, spells and dnd5e's prepared count as the player's own validation and creation
 * data; owned, in the default folder, with the portrait. Takes over the Phase 1 done-when (spike) checks.
 */

const FIXED = {
  legacy: { species: "Hill Dwarf", background: "Acolyte" },
  modern: { species: "Human", background: "Sage" }
};
const FOLDER = "Player Characters";

export function registerPhase2Batch(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.phase-2-done@gm`, ({ describe, it, before, after, assert }) => {
    describe("Phase 2 done: every SRD class submitted through the API becomes a correct actor", () => {
      let folderExisted;
      const draftIds = [];
      const gm = () => game.users.activeGM;
      const query = (name, data) => gm().query(name, data, { timeout: 120_000 });

      before(async function() {
        this.timeout(60_000);
        assert.isFalse(game.user.isGM, "run as a player");
        assert.exists(gm(), "no active GM — run with npm run test:foundry");
        await query(SUBMIT_TEST_QUERIES.CLEANUP, {});
        await query(SETTINGS_TEST_QUERIES.SET, { key: "characterLimit", value: 0 });
        folderExisted = game.folders.some(f => f.type === "Actor" && f.name === FOLDER);
      });
      after(async function() {
        this.timeout(120_000);
        if ( !gm() ) return;
        await query(SUBMIT_TEST_QUERIES.CLEANUP, {});
        await query(SETTINGS_TEST_QUERIES.SET, { key: "characterLimit", reset: true });
        if ( !folderExisted ) await query(SETTINGS_TEST_QUERIES.DELETE_FOLDER, { name: FOLDER });
        await query(ABILITY_TEST_QUERIES.CLEANUP, { draftIds });
      });

      it("every class: submitted, created, and equal to the validated build", async function() {
        this.timeout(900_000);
        const S = await import("./support.mjs");
        const V = await import("../scripts/rules/validate.mjs");
        const { characterData } = await import("../scripts/gm/create.mjs");
        const { preparePortrait } = await import("../scripts/portrait/prepare.mjs");
        const catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        const image = await preparePortrait(await S.makeTestImage(400, 500));
        const report = [];

        /** "type:name@container name" for every item, so container contents are compared too. */
        const lines = items => {
          const byId = new Map(items.map(i => [i._id ?? i.id, i]));
          return items.map(i => {
            const container = i.system?.container ? byId.get(i.system.container)?.name ?? "?" : "";
            return `${i.type}:${i.name}${container ? `@${container}` : ""}×${i.system?.quantity ?? 1}`;
          }).sort();
        };

        for ( const cls of catalog.byCategory.class ) {
          const draft = await legitDraft({ ...FIXED[rules()], class: cls.name }, { catalog });
          draftIds.push(draft.id);
          const validated = await V.validateDraft(draft, { catalog, userId: game.user.id });
          assert.isTrue(validated.ok, `${cls.name}: ${JSON.stringify(validated.errors).slice(0, 300)}`);
          const expected = await characterData(validated, { user: game.user, catalog });

          const stop = S.watchDb();
          const t0 = performance.now();
          const res = await query(QUERIES.SUBMIT, { draft, image });
          const ms = Math.round(performance.now() - t0);
          assert.deepEqual(stop(), [], `${cls.name}: the player's client wrote nothing`);
          assert.isTrue(res.ok, `${cls.name}: ${JSON.stringify(res.errors ?? []).slice(0, 300)}`);
          assert.deepEqual(res.warnings, [], cls.name);
          const actor = await fromUuid(res.actorUuid);

          assert.deepEqual(lines(actor.items.contents.map(i => i.toObject())), lines(expected.items), `${cls.name}: items`);
          for ( const k of ["str", "dex", "con", "int", "wis", "cha"] ) {
            assert.equal(actor.system.abilities[k].value, expected.system.abilities[k].value, `${cls.name} ${k}`);
          }
          assert.equal(actor.system.details.level, 1, cls.name);
          assert.equal(actor.system.attributes.hp.value, actor.system.attributes.hp.max, cls.name);
          assert.equal(actor.system.attributes.hp.max, expected.system.attributes.hp.value, `${cls.name} hp`);
          for ( const [k, v] of Object.entries(expected.system.currency) ) assert.equal(actor.system.currency[k], v, `${cls.name} ${k}`);
          // Container currency (e.g. the 2014 Acolyte's pouch) survives creation.
          for ( const c of actor.items.filter(i => i.type === "container") ) {
            const want = expected.items.find(i => i._id === c.id)?.system.currency ?? {};
            for ( const [k, v] of Object.entries(want) ) assert.equal(c.system.currency[k], v, `${cls.name} ${c.name} ${k}`);
          }
          // The player's picks. Spells granted by advancements (the 2024 Druid has one more class spell) are
          // covered by the item comparison above.
          const norm = u => u?.replace(/^(Compendium.[^.]+.[^.]+.)(?!Item.)/, "$1Item.");
          const picked = new Set([...draft.spells.cantrips, ...draft.spells.spellbook, ...draft.spells.spells].map(norm));
          const classId = actor.items.find(x => x.type === "class").identifier;
          const mine = actor.items.filter(i => i.type === "spell" && picked.has(norm(i._stats?.compendiumSource)));
          assert.equal(mine.length, picked.size, `${cls.name} spells`);
          assert.isTrue(mine.every(i => i.system.sourceItem === `class:${classId}`), `${cls.name} spells linked to the class`);
          const prep = actor.items.find(i => i.type === "class").system.spellcasting?.preparation;
          // 2014 Paladin: no spells at level 1, and dnd5e computes a maximum of −1 with CHA 8 (floor(1/2) − 1).
          if ( prep?.max > 0 ) assert.isAtMost(prep.value, prep.max, `${cls.name} prepared`);

          assert.equal(actor.ownership[game.user.id], CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER, cls.name);
          assert.equal(actor.ownership.default, CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, cls.name);
          assert.equal(actor.folder?.name, FOLDER, cls.name);
          assert.match(actor.img, new RegExp(`assets/actors/${actor.id}-[^/]+\\.webp$`), `${cls.name} portrait`);
          report.push(`${cls.name} ${ms}ms ${actor.items.size}it`);
        }
        console.log(`${MODULE_ID} | phase 2 done (${rules()}): ${report.join(", ")}`);
        assert.equal(game.actors.filter(a => a.getFlag(MODULE_ID, "created")?.userId === game.user.id).length,
          catalog.byCategory.class.length);
      });
    });
  }, { displayName: "Character Creator: Phase 2 done" });
}

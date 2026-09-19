import { MODULE_ID } from "../scripts/main.mjs";

/*
 * Phase 1 "Done when" (PLAN.md): from a Player-role account, build and submit a legal level-1
 * 2024 Fighter (modern-test) and 2014 Wizard with subrace, spellbook and portrait (legacy-test); the GM
 * side replays and creates each correctly with no manual fixes. Needs a GM online ("@gm").
 */
export function registerPhase1Batch(quench) {
  quench.registerBatch(`${MODULE_ID}.phase-1-done@gm`, ({ describe, it, before, after, assert }) => {
    describe("Phase 1 done-when — complete level-1 character, player → active GM", () => {
      let P;
      let prep;
      let result;
      let actor;
      let writes;
      const rules = () => game.settings.get("dnd5e", "rulesVersion");
      const query = (name, data) => game.users.activeGM.query(name, data, { timeout: 120_000 });
      const waitFor = async (fn, ms = 15_000) => {
        const end = Date.now() + ms;
        while ( Date.now() < end ) {
          const v = await fn();
          if ( v ) return v;
          await new Promise(r => setTimeout(r, 150));
        }
        return null;
      };
      const src = i => i._stats?.compendiumSource?.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.");
      const cleanup = async () => query(`${MODULE_ID}.spikeCleanup`, {});

      before(async function() {
        this.timeout(300_000);
        P = await import("../spike/phase1.mjs");
        assert.exists(game.users.activeGM, "no active GM — run with npm run test:foundry");
        await cleanup();
        prep = await P.prepareSubmission(rules());
      });
      after(async function() {
        this.timeout(60_000);
        if ( game.users.activeGM ) await cleanup();
      });

      it("submits as a Player-role user and the GM creates the character", async function() {
        this.timeout(180_000);
        assert.equal(game.user.role, CONST.USER_ROLES.PLAYER);
        const { watchDb } = await import("../spike/lib.mjs");
        const stop = watchDb();
        const t0 = performance.now();
        result = await query(P.SUBMIT_FULL, prep.payload);
        result.roundTripMs = Math.round(performance.now() - t0);
        writes = stop().filter(w => w.hook !== "game.actors.size changed");
        assert.isTrue(result.ok, JSON.stringify(result.errors ?? result));
        assert.deepEqual(result.warnings, []);
        actor = await waitFor(() => fromUuidSync(result.actorUuid));
        assert.exists(actor);
        await waitFor(() => actor.img === result.portrait);
        console.log(`${MODULE_ID} | phase 1 done (${rules()}): ${JSON.stringify({
          name: actor.name, roundTripMs: result.roundTripMs, ...result.diagnostics, req: prep.req,
          spells: { cantrips: prep.payload.spells.cantrips.length, spellbook: prep.payload.spells.spellbook.length,
            prepared: prep.payload.spells.spells.length } })}`);
      });

      it("the player's own client wrote nothing", () => {
        assert.deepEqual(writes, []);
      });

      it("level 1, HP, speed and ability scores match the player's build", () => {
        const b = prep.built.actor.system;
        const a = actor.system;
        assert.equal(a.details.level, 1);
        assert.equal(a.attributes.hp.max, prep.expected.hp);
        assert.equal(a.attributes.hp.value, prep.expected.hp);
        assert.isAbove(a.attributes.movement.walk, 0);
        assert.equal(a.attributes.movement.walk, prep.expected.speed);
        for ( const k of Object.keys(b.abilities) ) assert.equal(a.abilities[k].value, b.abilities[k].value, k);
      });

      it("proficiencies (skills, saves, weapons, armor, languages) match the build", () => {
        const b = prep.built.actor.system;
        const a = actor.system;
        for ( const [k, s] of Object.entries(b.skills) ) assert.equal(a.skills[k].value, s.value, `skill ${k}`);
        for ( const [k, s] of Object.entries(b.abilities) ) assert.equal(a.abilities[k].proficient, s.proficient, `save ${k}`);
        for ( const t of ["weaponProf", "armorProf", "languages"] ) {
          assert.sameMembers([...a.traits[t].value], [...b.traits[t].value], t);
        }
      });

      it("every item from the build is on the created actor", () => {
        const count = items => items.reduce((m, i) => m.set(src(i), (m.get(src(i)) ?? 0) + 1), new Map());
        const want = count(prep.built.actor.items);
        const have = count(actor.items);
        for ( const [u, n] of want ) assert.isAtLeast(have.get(u) ?? 0, n, u);
      });

      it("starting equipment: every resolved item with its quantity, containers with contents, currency", async () => {
        for ( const { uuid, count } of prep.expected.items ) {
          const want = uuid.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.");
          const found = actor.items.filter(i => src(i) === want);
          assert.isAbove(found.length, 0, `missing ${uuid}`);
          if ( count > 1 ) assert.isTrue(found.some(i => i.system.quantity === count), `${found[0]?.name} quantity ${count}`);
        }
        // Each container holds exactly what its compendium original holds (packs full; pouches and
        // quivers may ship empty).
        const containers = actor.items.filter(i => i.type === "container");
        assert.isAbove(containers.length, 0, "no container");
        let filled = 0;
        for ( const c of containers ) {
          const inside = actor.items.filter(i => i.system.container === c.id).length;
          const original = await fromUuid(src(c));
          const want = (await original?.system.contents)?.size ?? 0;
          assert.equal(inside, want, `${c.name}: ${inside} inside, compendium has ${want}`);
          // Coins held by a container (2014 Acolyte's Coin Pouch: 15 gp) are kept.
          for ( const [k, v] of Object.entries(original?.system.currency ?? {}) ) {
            assert.equal(c.system.currency?.[k] ?? 0, v, `${c.name} currency ${k}`);
          }
          if ( inside ) filled++;
        }
        assert.isAbove(filled, 0, "no container came with contents");
        for ( const [k, v] of Object.entries(prep.expected.currency) ) {
          assert.isAtLeast(actor.system.currency[k] ?? 0, v, `currency ${k}`);
        }
      });

      it("spells: counts and prepared state as dnd5e counts them", () => {
        const req = prep.req;
        const cls = actor.items.find(i => i.type === "class");
        const classSpells = actor.items.filter(i => i.type === "spell" && i.system.classIdentifier === cls.identifier);
        assert.equal(classSpells.filter(i => i.system.level === 0).length, req.cantrips, "cantrips");
        if ( req.spellbook ) assert.equal(classSpells.filter(i => i.system.level === 1).length, req.spellbook, "spellbook");
        const prepared = prep.payload.spells.spells.length;
        if ( req.mode === "prepared" ) {
          assert.equal(cls.system.spellcasting.preparation.value, prepared, "dnd5e prepared count");
          assert.isAtMost(prepared, cls.system.spellcasting.preparation.max);
        }
        if ( !req.caster ) assert.lengthOf(classSpells, 0);
      });

      it("portrait: img, token texture and dynamic ring point at the uploaded WebP", () => {
        assert.match(actor.img, new RegExp(`^worlds/${game.world.id}/assets/actors/${actor.id}-[A-Za-z0-9]+\\.webp$`));
        assert.equal(actor.prototypeToken.texture.src, actor.img);
        assert.isTrue(actor.prototypeToken.ring.enabled);
        assert.equal(actor.prototypeToken.ring.subject.texture, actor.img);
      });

      it("the player owns it and it is their assigned character", async () => {
        assert.equal(actor.ownership[game.user.id], CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
        assert.equal(actor.ownership.default, CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE);
        assert.isTrue(!!(await waitFor(() => game.user.character?.id === actor.id)));
      });

      it("tampered submissions are rejected and create nothing (equipment, spells)", async function() {
        this.timeout(120_000);
        const before = game.actors.size;
        // Equipment: a category pick that isn't in the category (use the first linked item of the kit instead).
        const eq = foundry.utils.deepClone(prep.payload);
        eq.draftId = foundry.utils.randomID();
        const role = Object.keys(eq.equipment).find(r => Object.keys(eq.equipment[r].picks ?? {}).length);
        if ( role ) {
          const [id] = Object.keys(eq.equipment[role].picks);
          eq.equipment[role].picks[id] = eq.equipment[role].picks[id].map(() => "Compendium.dnd5e.items.Item.none000000000000");
          const r1 = await query(P.SUBMIT_FULL, eq);
          assert.deepEqual([r1.ok, r1.step], [false, "equipment"], JSON.stringify(r1));
        }
        // Spells: one cantrip too many (casters), or any spell at all (non-casters).
        const sp = foundry.utils.deepClone(prep.payload);
        sp.draftId = foundry.utils.randomID();
        const extra = prep.req.caster ? sp.spells.cantrips.at(-1) : "Compendium.dnd5e.spells24.Item.phbsplFireBolt00";
        sp.spells.cantrips = [...(sp.spells.cantrips ?? []), extra];
        const r2 = await query(P.SUBMIT_FULL, sp);
        assert.deepEqual([r2.ok, r2.step], [false, "spells"], JSON.stringify(r2));
        assert.equal(game.actors.size, before);
      });

      it("clean-up deletes the character and its portrait file", async function() {
        this.timeout(60_000);
        const path = actor.img;
        await cleanup();
        assert.isTrue(!!(await waitFor(async () => (await fetch(`/${path}`, { cache: "no-store" })).status === 404)));
      });
    });
  }, { displayName: "Character Creator: Phase 1 done-when (needs GM)" });
}

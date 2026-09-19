import { MODULE_ID } from "../scripts/main.mjs";

/*
 * Phase 1 spike checks as Quench batches, so `npm run test:foundry` runs them unattended.
 * They import the throwaway spike code; Phase 2 replaces both with the real rules adapter and its tests.
 */

const ADVANCEMENT_TYPES = ["AbilityScoreImprovement", "HitPoints", "ItemChoice", "ItemGrant", "ScaleValue",
  "Size", "Subclass", "Trait"];

/** Types the spike 1.1 picks don't use at level 1 in a rule set (RESEARCH.md → Spike 1.1). */
const NOT_USED = { legacy: ["ItemChoice"], modern: ["Subclass"] };

/** Check ids spike 1.2 reports per rule set. */
const CHECKS_1_2 = {
  legacy: ["D1", "L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10", "L11", "G1"],
  modern: ["D1", "M1", "M2", "M3", "M4", "M4b", "M5", "M6", "M7", "M8", "M9", "G1"]
};

const rules = () => game.settings.get("dnd5e", "rulesVersion");
const brief = value => JSON.stringify(value)?.slice(0, 1500);

export function registerSpikeBatches(quench) {
  quench.registerBatch(`${MODULE_ID}.spike-1-1`, ({ describe, it, before, assert }) => {
    describe("Spike 1.1 — every advancement type applies on an unsaved actor", () => {
      let report;
      let initialsBefore;
      before(async function() {
        this.timeout(120_000);
        const lib = await import("../spike/lib.mjs");
        initialsBefore = lib.schemaInitials();
        report = await (await import("../spike/advancement-apply.mjs")).run();
      });

      it("writes nothing to the database", () => {
        assert.deepEqual(report.dbWrites, [], brief(report.dbWrites));
        assert.isTrue(report.actorsUnchanged);
        assert.isTrue(report.final?.stillUnsaved);
      });
      it("applies every advancement without error", () => {
        assert.deepEqual(report.errors, [], brief(report.errors));
        assert.deepEqual(report.steps.filter(s => s.error).map(s => [s.item, s.type, s.error.message]), []);
      });
      for ( const type of ADVANCEMENT_TYPES ) {
        it(`covers ${type}`, function() {
          if ( NOT_USED[rules()]?.includes(type) ) this.skip();
          assert.include(report.typesSeen, type);
        });
      }
      it("leaves schema defaults untouched", async () => {
        const after = (await import("../spike/lib.mjs")).schemaInitials();
        const changed = Object.keys(initialsBefore).filter(k => initialsBefore[k] !== after[k]);
        assert.deepEqual(changed, []);
      });
    });
  }, { displayName: "Character Creator: Spike 1.1" });

  quench.registerBatch(`${MODULE_ID}.spike-1-2`, ({ describe, it, before, assert }) => {
    describe("Spike 1.2 — order, reverse and re-apply", () => {
      let report;
      before(async function() {
        this.timeout(300_000);
        report = await (await import("../spike/order-reverse.mjs")).run();
      });

      it("writes nothing to the database and throws nothing", () => {
        assert.deepEqual(report.dbWrites, [], brief(report.dbWrites));
        assert.deepEqual(report.errors, [], brief(report.errors));
        assert.deepEqual(report.stepErrors, [], brief(report.stepErrors));
      });
      const ids = [...new Set([...CHECKS_1_2.legacy, ...CHECKS_1_2.modern])];
      for ( const id of ids ) {
        it(`check ${id} is as expected`, function() {
          if ( !CHECKS_1_2[rules()]?.includes(id) ) this.skip();
          const check = report.checks.find(c => c.id === id);
          assert.exists(check, `check ${id} did not run`);
          assert.isTrue(check.ok, `${check.name ?? id}: ${check.error ?? brief(check.differences ?? check)}`);
        });
      }
    });
  }, { displayName: "Character Creator: Spike 1.2" });

  quench.registerBatch(`${MODULE_ID}.spike-1-3`, ({ describe, it, before, assert }) => {
    describe("Spike 1.3 — replay from the recipe, tamper detection, timing", () => {
      let report;
      before(async function() {
        this.timeout(300_000);
        report = await (await import("../spike/replay.mjs")).run();
      });

      it("writes nothing to the database and throws nothing", () => {
        assert.deepEqual(report.dbWrites, [], brief(report.dbWrites));
        assert.deepEqual(report.errors, [], brief(report.errors));
      });
      const ids = ["R0", "R1", "R2", "T1", "T2", "T3", "T3b", "T4", "T4b", "T5", "T6", "P1", "G1"];
      for ( const id of ids ) {
        it(`check ${id}`, function() {
          const check = report.checks.find(c => c.id === id);
          if ( !check && !["R0", "R1", "R2", "P1", "G1"].includes(id) && !report.tamperIds?.includes(id) ) this.skip();
          assert.exists(check, `check ${id} did not run`);
          assert.isTrue(check.ok, `${check.name}: ${brief(check.errors ?? check.differences ?? check)}`);
        });
      }
      it("reports the timing", () => {
        assert.exists(report.timing);
        const tampers = report.checks.filter(c => c.id.startsWith("T"))
          .map(c => ({ id: c.id, codes: (c.errors ?? []).map(e => `${e.code}@${e.step}: ${JSON.stringify(e.detail)}`.slice(0, 160)) }));
        console.log(`character-creator | spike 1.3 summary (${rules()}): ${JSON.stringify({
          timing: report.timing, recipeBytes: report.recipeBytes, recipeSteps: report.recipeSteps, tampers })}`);
      });
    });
  }, { displayName: "Character Creator: Spike 1.3" });

  // Needs a GM online (key ends in "@gm"): the runner opens a Gamemaster session alongside Player A.
  quench.registerBatch(`${MODULE_ID}.spike-1-4@gm`, ({ describe, it, before, after, assert }) => {
    describe("Spike 1.4 — player submits, active GM validates and creates", () => {
      let lib;
      let replayMod;
      let submit;
      let built;
      let recipe;
      const draftId = foundry.utils.randomID();
      let result;
      let playerWrites;
      let actor;
      const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
      const query = (name, data) => game.users.activeGM.query(name, data, { timeout: 30_000 });
      const waitFor = async (fn, ms = 10_000) => {
        const end = Date.now() + ms;
        while ( Date.now() < end ) {
          const v = fn();
          if ( v ) return v;
          await new Promise(r => setTimeout(r, 100));
        }
        return null;
      };
      const spikeActors = () => game.actors.filter(a => a.getFlag(MODULE_ID, "spike14"));

      before(async function() {
        this.timeout(120_000);
        lib = await import("../spike/lib.mjs");
        replayMod = await import("../spike/replay.mjs");
        submit = await import("../spike/submit.mjs");
        assert.exists(game.users.activeGM, "no active GM — run with npm run test:foundry");
        await query(submit.CLEANUP, {});
        built = await lib.buildCharacter(rules());
        recipe = JSON.parse(JSON.stringify(replayMod.extractRecipe(built, rules())));
      });
      after(async function() {
        this.timeout(60_000);
        if ( submit && game.users.activeGM ) await query(submit.CLEANUP, {});
      });

      it("runs as a Player-role user with a GM online", () => {
        assert.isFalse(game.user.isGM);
        assert.equal(game.user.role, CONST.USER_ROLES.PLAYER);
        assert.isTrue(game.users.activeGM.active);
      });

      it("a player cannot create an actor directly (D13)", async () => {
        const before = game.actors.size;
        let threw;
        try {
          const a = await Actor.implementation.create({ name: "should not exist", type: "character" });
          threw = !a;
        } catch {
          threw = true;
        }
        assert.isTrue(threw, "Actor.create should fail for a Player");
        assert.equal(game.actors.size, before);
      });

      it("submit → the GM creates the actor", async function() {
        this.timeout(60_000);
        const stop = lib.watchDb();
        const actorsBefore = game.actors.size;
        const t0 = performance.now();
        result = await query(submit.SUBMIT, { recipe, draftId, name: "Spike 1.4 Hero" });
        result.roundTripMs = Math.round(performance.now() - t0);
        // The watcher also flags a changed game.actors size — expected here (the GM's actor arrives).
        playerWrites = stop().filter(w => w.hook !== "game.actors.size changed");
        result.actorsAdded = () => game.actors.size - actorsBefore;
        assert.isTrue(result.ok, JSON.stringify(result.errors));
        actor = await waitFor(() => fromUuidSync(result.actorUuid));
        assert.exists(actor, "the created actor never reached the player");
        console.log(`${MODULE_ID} | spike 1.4 submit (${rules()}): ${JSON.stringify({
          roundTripMs: result.roundTripMs, ...result.diagnostics })}`);
      });

      it("the player's own client wrote nothing; exactly one actor arrived from the GM", () => {
        assert.deepEqual(playerWrites, [], JSON.stringify(playerWrites));
        assert.equal(result.actorsAdded(), 1);
      });

      it("creating the actor opened no windows on the GM (no AdvancementManager)", () => {
        assert.deepEqual(result.diagnostics.opened, []);
      });

      it("the created actor ≡ the player's build", () => {
        const r = lib.compare(lib.snapshot(actor), lib.snapshot(built.actor));
        assert.isTrue(r.equal, JSON.stringify(r.differences).slice(0, 1500));
      });

      it("the player owns it; nobody else does by default", () => {
        assert.equal(actor.ownership[game.user.id], OWNER);
        assert.equal(actor.ownership.default, CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE);
        assert.isTrue(actor.isOwner);
      });

      it("it is assigned as the player's character", async () => {
        const assigned = await waitFor(() => game.user.character?.id === actor.id);
        assert.isTrue(!!assigned, `user.character is ${game.user.character?.id}`);
      });

      it("resubmitting the same draft does not duplicate it", async () => {
        const again = await query(submit.SUBMIT, { recipe, draftId });
        assert.isTrue(again.ok);
        assert.isTrue(again.duplicate);
        assert.equal(again.actorUuid, result.actorUuid);
        assert.lengthOf(spikeActors(), 1);
      });

      it("a tampered recipe is rejected and nothing is created", async () => {
        const tampered = foundry.utils.deepClone(recipe);
        const skills = tampered.steps.find(s => s.data?.chosen?.some(k => k.startsWith("skills:"))
          && s.item === recipe.picks.class);
        skills.data.chosen.push("skills:ste");
        const res = await query(submit.SUBMIT, { recipe: tampered, draftId: foundry.utils.randomID() });
        assert.isFalse(res.ok);
        assert.isTrue(res.errors.some(e => ["TOO_MANY_PICKS", "NOT_ALLOWED"].includes(e.code)), JSON.stringify(res.errors));
        assert.lengthOf(spikeActors(), 1);
      });

      it("a recipe for the other rule set is rejected", async () => {
        const other = { ...recipe, rules: rules() === "legacy" ? "modern" : "legacy" };
        const res = await query(submit.SUBMIT, { recipe: other, draftId: foundry.utils.randomID() });
        assert.isFalse(res.ok);
        assert.equal(res.errors[0].code, "RULES_MISMATCH");
      });

      it("clean-up removes the spike actor and the assignment", async function() {
        this.timeout(30_000);
        const res = await query(submit.CLEANUP, {});
        assert.equal(res.deleted, 1);
        assert.isTrue(!!(await waitFor(() => !spikeActors().length && !game.user.character)));
      });
    });
  }, { displayName: "Character Creator: Spike 1.4 (needs GM)" });

  /* -------------------------------------------- */

  // Player side only, with no GM online: checks, resize, WebP encoding, and the offline refusal (A5).
  quench.registerBatch(`${MODULE_ID}.spike-1-5`, ({ describe, it, before, assert }) => {
    describe("Spike 1.5 — portrait: player-side preparation", () => {
      let P;
      const expectCode = async (promise, code) => {
        try {
          await promise;
        } catch ( err ) {
          assert.equal(err.code, code, err.message);
          return;
        }
        assert.fail(`expected ${code}`);
      };
      before(async () => {
        P = await import("../spike/portrait.mjs");
      });

      it("resizes a large PNG to ≤ 1024 px WebP ≤ 512 KB, keeping the aspect ratio", async function() {
        this.timeout(60_000);
        const src = await P.makeTestImage(3000, 2000);
        const t0 = performance.now();
        const out = await P.preparePortrait(src);
        out.ms = Math.round(performance.now() - t0);
        assert.equal(out.mime, "image/webp");
        assert.equal(out.width, 1024);
        assert.equal(out.height, 683);
        assert.isAtMost(out.bytes, P.LIMITS.maxBytes);
        console.log(`${MODULE_ID} | spike 1.5 resize: ${JSON.stringify({ ...out, data: `${out.data.length} chars` })}`);
      });
      it("does not upscale a small image", async function() {
        this.timeout(30_000);
        const out = await P.preparePortrait(await P.makeTestImage(400, 300));
        assert.deepEqual([out.width, out.height], [400, 300]);
      });
      it("steps quality down until a noisy image fits in 512 KB", async function() {
        this.timeout(120_000);
        const src = await P.makeTestImage(1400, 1400, { noise: true });  // ~7.8 MB PNG, under the 10 MB limit
        assert.isBelow(src.size, P.LIMITS.maxSourceBytes);
        const t0 = performance.now();
        const out = await P.preparePortrait(src);
        out.ms = Math.round(performance.now() - t0);
        assert.isAtMost(out.bytes, P.LIMITS.maxBytes);
        assert.isBelow(out.quality, 0.9);
        console.log(`${MODULE_ID} | spike 1.5 noisy: ${JSON.stringify({ bytes: out.bytes, quality: out.quality, ms: out.ms })}`);
      });
      it("rejects a non-image type before decoding", async () => {
        await expectCode(P.preparePortrait(new Blob(["hello"], { type: "text/plain" })), "WRONG_TYPE");
      });
      it("rejects a file over 10 MB before decoding", async () => {
        await expectCode(P.preparePortrait(new Blob([new Uint8Array(11 * 1024 * 1024)], { type: "image/png" })), "TOO_LARGE");
      });
      it("rejects a corrupt image", async () => {
        await expectCode(P.preparePortrait(new Blob([new Uint8Array(1000)], { type: "image/png" })), "UNREADABLE");
      });
      it("refuses to send when no GM is online (A5)", async function() {
        this.timeout(30_000);
        assert.notExists(game.users.activeGM, "a GM is online — close other GM sessions for this batch");
        const out = await P.preparePortrait(await P.makeTestImage(200, 200));
        await expectCode(P.sendPortrait("Actor.x", out), "GM_OFFLINE");
      });
    });
  }, { displayName: "Character Creator: Spike 1.5 (player side)" });

  // The relay: player → active GM → FilePicker.upload → actor img, token texture and ring.
  quench.registerBatch(`${MODULE_ID}.spike-1-5@gm`, ({ describe, it, before, after, assert }) => {
    describe("Spike 1.5 — portrait relay through the active GM", () => {
      let P;
      let submit;
      let actor;
      let image;
      let first;
      let second;
      let writes;
      const ring = { ring: "#c9a227", background: "#1b2a49", effects: 3 };
      const query = (name, data) => game.users.activeGM.query(name, data, { timeout: 60_000 });
      const waitFor = async (fn, ms = 10_000) => {
        const end = Date.now() + ms;
        while ( Date.now() < end ) {
          const v = await fn();
          if ( v ) return v;
          await new Promise(r => setTimeout(r, 150));
        }
        return null;
      };
      const status = async path => (await fetch(`/${path}`, { cache: "no-store" })).status;

      before(async function() {
        this.timeout(60_000);
        P = await import("../spike/portrait.mjs");
        submit = await import("../spike/submit.mjs");
        await query(submit.CLEANUP, {});
        const { uuid } = await query(P.MAKE_ACTOR, { owned: true });
        actor = await waitFor(() => fromUuidSync(uuid));
        image = await P.preparePortrait(await P.makeTestImage(1600, 1600));
      });
      after(async function() {
        this.timeout(30_000);
        if ( submit && game.users.activeGM ) await query(submit.CLEANUP, {});
      });

      it("the player has no upload permission of their own", () => {
        assert.isFalse(game.user.can("FILES_UPLOAD"));
        assert.isFalse(game.user.can("FILES_BROWSE"));
      });

      it("the GM saves the portrait under the actor's asset path", async function() {
        this.timeout(60_000);
        const { watchDb } = await import("../spike/lib.mjs");
        const stop = watchDb();
        const t0 = performance.now();
        first = await P.sendPortrait(actor.uuid, image, ring);
        first.roundTripMs = Math.round(performance.now() - t0);
        writes = stop();
        assert.isTrue(first.ok, JSON.stringify(first));
        assert.match(first.path, new RegExp(`^worlds/${game.world.id}/assets/actors/${actor.id}-[A-Za-z0-9]+\\.webp$`));
        console.log(`${MODULE_ID} | spike 1.5 upload: ${JSON.stringify({ path: first.path, roundTripMs: first.roundTripMs, ...first.diagnostics })}`);
      });

      it("the player's client wrote nothing", () => {
        assert.deepEqual(writes, []);
      });

      it("the file is served to the player, byte for byte", async () => {
        const res = await fetch(`/${first.path}`, { cache: "no-store" });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type") ?? "", /image\/webp/);
        assert.equal((await res.arrayBuffer()).byteLength, image.bytes);
      });

      it("img, token texture and ring all point at it, with the chosen colors", async () => {
        const ok = await waitFor(() => actor.img === first.path);
        assert.isTrue(!!ok, `img is ${actor.img}`);
        const t = actor.prototypeToken;
        assert.equal(t.texture.src, first.path);
        assert.isTrue(t.ring.enabled);
        assert.equal(t.ring.subject.texture, first.path);
        assert.equal(t.ring.colors.ring.css, ring.ring);
        assert.equal(t.ring.colors.background.css, ring.background);
        assert.equal(t.ring.effects, ring.effects);
      });

      it("refuses an actor the player doesn't own", async () => {
        const { uuid } = await query(P.MAKE_ACTOR, { owned: false });
        const res = await P.sendPortrait(uuid, image, ring);
        assert.deepEqual([res.ok, res.code], [false, "NOT_OWNER"]);
      });

      it("refuses tampered images (type, size, signature, dimensions)", async () => {
        const bad = [
          { ...image, mime: "image/png" },
          { ...image, data: btoa("x".repeat(600 * 1024)) },
          { ...image, data: btoa(`GIF89a${"x".repeat(100)}`) },
          { ...image, width: image.width + 1 }
        ];
        for ( const img of bad ) {
          const res = await P.sendPortrait(actor.uuid, img, ring);
          assert.deepEqual([res.ok, res.code], [false, "BAD_IMAGE"], JSON.stringify(res.detail));
        }
      });

      it("a second upload gets a new file name (no stale cache) and the actor follows it", async function() {
        this.timeout(60_000);
        const img2 = await P.preparePortrait(await P.makeTestImage(800, 1200));
        second = await P.sendPortrait(actor.uuid, img2, ring);
        assert.isTrue(second.ok);
        assert.notEqual(second.path, first.path);
        assert.isTrue(!!(await waitFor(() => actor.img === second.path)));
        assert.equal(await status(first.path), 200, "the previous file stays until the actor is deleted");
      });

      it("deleting the actor deletes its uploaded files (server-side)", async function() {
        this.timeout(30_000);
        await query(submit.CLEANUP, {});
        const gone = await waitFor(async () => (await status(first.path)) === 404 && (await status(second.path)) === 404);
        assert.isTrue(!!gone, "uploaded portraits still served after the actor was deleted");
      });
    });
  }, { displayName: "Character Creator: Spike 1.5 (needs GM)" });

  /* -------------------------------------------- */

  quench.registerBatch(`${MODULE_ID}.spike-1-6`, ({ describe, it, before, assert }) => {
    describe("Spike 1.6 — starting equipment for every SRD class and background", () => {
      let EQ;
      let core;
      let survey;
      let built;
      const fmt = rows => rows.map(r => r.name).join(", ");

      before(async function() {
        this.timeout(300_000);
        const lib = await import("../spike/lib.mjs");
        EQ = await import("../spike/equipment.mjs");
        core = await import("../spike/equipment-core.mjs");
        built = await lib.buildCharacter(rules());
        survey = await EQ.survey(rules(), built.actor);
        const summary = survey.rows.map(r => ({
          name: r.name, type: r.type, wealth: r.wealth, range: r.wealthRollRange, items: r.items, docs: r.createdDocs,
          containers: r.containers?.length, currency: r.currency,
          categories: r.categories.map(c => `${c.type}:${c.key}×${c.count}→${c.candidates}`),
          ifProficient: r.requiresProficiency.length
        }));
        console.log(`${MODULE_ID} | spike 1.6 survey (${rules()}): ${JSON.stringify(summary)}`);
        const names = {};
        for ( const r of survey.rows ) for ( const c of r.categories ) {
          const node = r.tree.nodes.get(c.id);
          names[`${c.type}:${c.key}`] ??= EQ.candidatesFor(node, survey.index)
            .map(u => survey.index.find(e => e.uuid === u)?.name);
        }
        console.log(`${MODULE_ID} | spike 1.6 candidates (${rules()}): ${JSON.stringify(names)}`);
        const pouch = rules() === "legacy" ? await fromUuid("Compendium.dnd5e.backgrounds.Item.dQaOdm9dbVN0RZYP") : null;
        if ( pouch ) console.log(`${MODULE_ID} | spike 1.6 coin pouch: ${JSON.stringify({ currency: pouch.system.currency,
          contents: (await pouch.system.contents)?.map?.(i => i.name) ?? [] })}`);
      });

      it("finds every SRD class and background of this rule set", () => {
        const expect = rules() === "legacy" ? { class: 12, background: 1 } : { class: 12, background: 4 };
        assert.equal(survey.rows.filter(r => r.type === "class").length, expect.class);
        assert.equal(survey.rows.filter(r => r.type === "background").length, expect.background);
      });
      it("uses only entry types the resolver knows", () => {
        assert.deepEqual(survey.rows.filter(r => r.unknownTypes.length).map(r => [r.name, r.unknownTypes]), []);
      });
      it("every linked item exists and is a physical item (some live outside the equipment pack)", async () => {
        assert.deepEqual(survey.rows.filter(r => r.missingLinked.length).map(r => [r.name, r.missingLinked]), []);
        const outside = [];
        for ( const r of survey.rows ) {
          for ( const uuid of r.linkedNotInEquipmentIndex ) {
            const doc = await fromUuid(uuid);
            outside.push({ from: r.name, uuid, name: doc?.name, type: doc?.type, rules: doc?.system.source?.rules,
              physical: !!doc?.system?.constructor?.metadata?.hasQuantity || ("quantity" in (doc?.system ?? {})) });
          }
        }
        console.log(`${MODULE_ID} | spike 1.6 linked outside the equipment pack (${rules()}): ${JSON.stringify(outside)}`);
        assert.isTrue(outside.every(o => o.physical), JSON.stringify(outside));
      });
      it("every category entry has enough non-magical candidates", () => {
        const short = survey.rows.flatMap(r => r.categories.filter(c => c.candidates < 1)
          .map(c => `${r.name} ${c.type}:${c.key}`));
        assert.deepEqual(short, []);
      });
      it("category candidates are dnd5e's base items only (SRD counts; no Unarmed Strike)", () => {
        const counts = {};
        for ( const r of survey.rows ) for ( const c of r.categories ) counts[`${c.type}:${c.key}`] = c.candidates;
        if ( rules() === "legacy" ) {
          assert.include(counts, { "weapon:sim": 14, "weapon:simpleM": 10, "weapon:martialM": 18, "weapon:mar": 23,
            "tool:music": 10 });
        } else assert.include(counts, { "tool:music": 10, "tool:art": 17, "tool:game": 4 });
        const names = survey.rows.flatMap(r => r.categories.flatMap(c => EQ.candidatesFor(r.tree.nodes.get(c.id), survey.index)))
          .map(u => survey.index.find(e => e.uuid === u)?.name);
        assert.notInclude(names, "Unarmed Strike");
      });
      it("a default selection resolves with no errors for every item", () => {
        assert.deepEqual(survey.rows.filter(r => r.errors.length).map(r => [r.name, r.errors]), []);
      });
      it("the resolved items become creation data (containers with contents) that embeds", () => {
        assert.deepEqual(survey.rows.filter(r => r.problems.length).map(r => [r.name, r.problems]), []);
        assert.isTrue(survey.rows.every(r => r.embedded === r.createdDocs), fmt(survey.rows.filter(r => r.embedded !== r.createdDocs)));
        assert.isAbove(survey.rows.reduce((n, r) => n + (r.containers?.length ?? 0), 0), 0, "no container found");
      });
      it("wealth: 2014 classes have a dice formula whose range matches Foundry's Roll; 2024 a flat GP amount", () => {
        for ( const r of survey.rows.filter(x => x.type === "class") ) {
          if ( rules() === "legacy" ) {
            assert.exists(r.wealthOption?.formula, r.name);
            assert.deepEqual(r.wealthRollRange, [r.wealthOption.min, r.wealthOption.max], r.name);
          } else assert.isNumber(r.wealthOption?.fixed, r.name);
        }
      });
      it("2024: every class and background offers the flat wealth alternative", function() {
        if ( rules() !== "modern" ) this.skip();
        for ( const r of survey.rows ) {
          const tree = r.tree;
          const res = core.resolveSelection(tree, r.wealth, { mode: "wealth" });
          assert.deepEqual(res.errors, [], r.name);
          assert.isAbove(res.currency.gp, 0, r.name);
        }
      });
      it("'if proficient' options follow dnd5e's proficiency on the built character", async function() {
        if ( rules() !== "legacy" ) this.skip();
        const cleric = survey.rows.find(r => r.name === "Cleric");
        assert.isAbove(cleric.requiresProficiency.length, 0);
        // Hill Dwarf Life Cleric: Dwarven Combat Training (warhammer) and Life Domain (heavy armor).
        const yes = await EQ.proficiencyChecker(built.actor, cleric.requiresProficiency);
        assert.isTrue(cleric.requiresProficiency.every(yes), "should be proficient with both");
        const stripped = new Actor.implementation(foundry.utils.mergeObject(built.actor.toObject(), {
          "system.traits.weaponProf.value": ["sim"], "system.traits.armorProf.value": ["lgt", "med", "shl"]
        }, { inplace: false }));
        const no = await EQ.proficiencyChecker(stripped, cleric.requiresProficiency);
        assert.isTrue(cleric.requiresProficiency.every(u => !no(u)), "should not be proficient without them");
      });
      it("tampered picks are rejected: wrong category and magic items", async () => {
        // A category the default selection actually reaches (not one in an unchosen OR branch).
        let row;
        let cat;
        for ( const r of survey.rows ) {
          const reached = new Set(core.listDecisions(r.tree, r.selection.choices).map(d => d.id));
          cat = r.categories.find(c => reached.has(c.id));
          if ( cat ) {
            row = r;
            break;
          }
        }
        assert.exists(row, "no reachable category entry in this rule set");
        const node = row.tree.nodes.get(cat.id);
        const all = await game.packs.get(EQ.EQUIPMENT_PACKS[rules()][0]).getIndex({ fields: ["system.rarity", "type"] });
        const magic = all.find(e => e.system?.rarity && e.type === (node.type === "armor" ? "equipment" : node.type));
        const wrong = survey.index.find(e => !EQ.matchesCategory(node, e));
        const inCategory = (n, u) => EQ.candidatesFor(n, survey.index).includes(u);
        for ( const bad of [wrong?.uuid, magic?.uuid].filter(Boolean) ) {
          const sel = foundry.utils.deepClone(row.selection);
          sel.picks[cat.id] = Array(cat.count ?? 1).fill(bad);
          const res = core.resolveSelection(row.tree, row.wealth, sel, { inCategory, isProficient: () => true });
          assert.isTrue(res.errors.some(e => e.code === "NOT_IN_CATEGORY"), `${row.name}: ${bad} accepted`);
        }
      });
    });
  }, { displayName: "Character Creator: Spike 1.6" });

  /* -------------------------------------------- */

  quench.registerBatch(`${MODULE_ID}.spike-1-7`, ({ describe, it, before, assert }) => {
    describe("Spike 1.7 — level-1 spell counts from class data", () => {
      let rows;
      before(async function() {
        this.timeout(120_000);
        const SP = await import("../spike/spells.mjs");
        rows = await SP.survey(rules());
        console.log(`${MODULE_ID} | spike 1.7 survey (${rules()}): ${JSON.stringify(rows)}`);
      });
      it("surveys all 12 SRD classes", () => {
        assert.lengthOf(rows, 12);
      });

      // Oracle: level-1 numbers from the 2014 / 2024 Player's Handbooks (test expectations only —
      // the module reads them from dnd5e's data). Scores are all 14 (+2), so 2014 prepared = 2 + 1.
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
      const casterRows = () => rows.filter(r => ORACLE[rules()][r.name]?.[0] !== "none" && ORACLE[rules()][r.name]);

      it("requirements read from dnd5e's data match the Player's Handbook for every class", async () => {
        const core = await import("../spike/spells-core.mjs");
        const got = {};
        for ( const r of rows ) {
          const q = core.requirements(r);
          got[r.name] = [q.mode, q.cantrips, q.spells, ...(q.spellbook ? [q.spellbook] : [])];
        }
        const want = Object.fromEntries(rows.map(r => [r.name, ORACLE[rules()][r.name] ?? ["none", 0, 0]]));
        assert.deepEqual(got, want);
      });

      it("Warlock uses pact magic with one level-1 slot", async () => {
        const core = await import("../spike/spells-core.mjs");
        const w = rows.find(r => r.name === "Warlock");
        assert.deepEqual([core.requirements(w).method, w.slots.pact, w.slots.pactLevel], ["pact", 1, 1]);
      });

      it("every caster's class list has enough cantrips and level-1 spells in this rule set's pack", async () => {
        const core = await import("../spike/spells-core.mjs");
        for ( const r of casterRows() ) {
          const q = core.requirements(r);
          assert.isAtLeast(r.list.level0, q.cantrips, `${r.name} cantrips`);
          assert.isAtLeast(r.list.level1, Math.max(q.spells, q.spellbook), `${r.name} level 1`);
          assert.equal(r.list.outsidePack, 0, `${r.name} list points outside the pack`);
        }
      });

      it("a legal selection validates, and dnd5e counts the prepared spells as expected", async function() {
        this.timeout(120_000);
        const core = await import("../spike/spells-core.mjs");
        const SP = await import("../spike/spells.mjs");
        const levels = await SP.spellLevels(rules());
        const report = {};
        for ( const r of casterRows() ) {
          const q = core.requirements(r);
          const list = [...r.live.listUuids];
          const cantrips = list.filter(u => levels.get(u) === 0).slice(0, q.cantrips);
          const lvl1 = list.filter(u => levels.get(u) === 1);
          const spellbook = lvl1.slice(0, q.spellbook);
          const spells = (q.spellbook ? spellbook : lvl1).slice(0, q.spells);
          const sel = { cantrips, spells, spellbook };
          assert.deepEqual(core.validateSpells(q, sel, r.live.listUuids, levels), [], r.name);
          const out = await SP.embedSpells(r, sel);
          const expectPrepared = q.mode === "prepared" ? spells.length : 0;
          assert.equal(out.preparedValue, expectPrepared, `${r.name}: dnd5e prepared count`);
          assert.isAtMost(out.preparedValue, out.preparedMax, `${r.name}: over dnd5e's maximum`);
          assert.deepEqual(out.classIdentifiers, [r.identifier], `${r.name}: spells linked to the class`);
          report[r.name] = { ...out, cantrips: cantrips.length, spells: spells.length, spellbook: spellbook.length };
        }
        console.log(`${MODULE_ID} | spike 1.7 embedded (${rules()}): ${JSON.stringify(report)}`);
      });

      it("tampered selections are rejected: off-list spell, level-2 spell, too many", async () => {
        const core = await import("../spike/spells-core.mjs");
        const SP = await import("../spike/spells.mjs");
        const levels = await SP.spellLevels(rules());
        const target = casterRows().find(r => r.name === "Cleric");
        const wizard = rows.find(r => r.name === "Wizard");
        const q = core.requirements(target);
        const mine = [...target.live.listUuids];
        const cantrips = mine.filter(u => levels.get(u) === 0).slice(0, q.cantrips);
        const offList = [...wizard.live.listUuids].find(u => levels.get(u) === 1 && !target.live.listUuids.has(u));
        const level2 = mine.find(u => levels.get(u) === 2);
        const lvl1 = mine.filter(u => levels.get(u) === 1);
        const codes = spells => core.validateSpells(q, { cantrips, spells }, target.live.listUuids, levels).map(e => e.code);
        assert.include(codes([offList]), "NOT_ON_LIST");
        assert.include(codes([level2]), "WRONG_LEVEL");
        assert.include(codes(lvl1.slice(0, q.spells + 1)), "SPELL_COUNT");
      });
    });
  }, { displayName: "Character Creator: Spike 1.7" });
}

import { MODULE_ID } from "../scripts/main.mjs";
import { LIMITS } from "../scripts/contracts.mjs";
import { SUBMIT_TEST_QUERIES } from "./submit.mjs";

/*
 * Portraits (D8–D10, D22, A5) on the production code: preparation in the player's browser
 * (scripts/portrait/prepare.mjs), the relay through the active GM (gm/portrait.mjs via uploadPortrait), and the
 * server removing the files with the actor. Carries over the coverage of spike 1.5.
 */

const MAKE_ACTOR = `${MODULE_ID}.test.portraitActor`;

export function registerPortraitTestQueries() {
  // A bare character for the relay tests, owned by the sender or by nobody (deleted by the submit clean-up).
  CONFIG.queries[MAKE_ACTOR] = async ({ owned = true } = {}, { user }) => {
    if ( !game.user.isGM || !game.users.activeGM?.isSelf ) throw new Error("Only the active GM");
    const L = CONST.DOCUMENT_OWNERSHIP_LEVELS;
    const actor = await Actor.implementation.create({ name: owned ? "Portrait test" : "Portrait test (not yours)", type: "character",
      ownership: owned ? { default: L.NONE, [user.id]: L.OWNER } : { default: L.NONE }, flags: { [MODULE_ID]: { submitTest: true } } });
    return actor.uuid;
  };
}

const bytesOf = image => atob(image.data).length;

export function registerPortraitBatches(quench) {
  // Player side, with no GM online: checks, resize, encoding, and the offline refusal (A5).
  quench.registerBatch(`${MODULE_ID}.portrait@nogm`, ({ describe, it, before, assert }) => {
    describe("Portrait: preparation in the player's browser", () => {
      let P;
      let S;
      const code = async promise => (await promise.then(() => null, e => e))?.error?.code ?? "no error";
      before(async () => {
        P = await import("../scripts/portrait/prepare.mjs");
        S = await import("./support.mjs");
      });

      it("resizes a large PNG to ≤ 1024 px WebP ≤ 512 KB, keeping the aspect ratio", async function() {
        this.timeout(60_000);
        const out = await P.preparePortrait(await S.makeTestImage(3000, 2000));
        assert.equal(out.mime, "image/webp");
        assert.deepEqual([out.width, out.height], [1024, 683]);
        assert.isAtMost(bytesOf(out), LIMITS.portraitMaxBytes);
        const b = Uint8Array.from(atob(out.data.slice(0, 16)), c => c.charCodeAt(0));
        assert.equal(String.fromCharCode(...b.subarray(8, 12)), "WEBP");
      });
      it("does not upscale a small image", async function() {
        this.timeout(30_000);
        const out = await P.preparePortrait(await S.makeTestImage(400, 300));
        assert.deepEqual([out.width, out.height], [400, 300]);
      });
      it("steps quality down until a noisy image fits in 512 KB", async function() {
        this.timeout(120_000);
        const src = await S.makeTestImage(1400, 1400, { noise: true });
        assert.isBelow(src.size, LIMITS.portraitSourceMaxBytes);
        const out = await P.preparePortrait(src);
        assert.isAtMost(bytesOf(out), LIMITS.portraitMaxBytes);
      });
      it("rejects a non-image, a file over the limit, and a corrupt image — with contract codes", async () => {
        assert.equal(await code(P.preparePortrait(new Blob(["hello"], { type: "text/plain" }))), "WRONG_IMAGE_TYPE");
        assert.equal(await code(P.preparePortrait(new Blob([new Uint8Array(11 * 1024 * 1024)], { type: "image/png" }))), "IMAGE_TOO_LARGE");
        assert.equal(await code(P.preparePortrait(new Blob([new Uint8Array(1000)], { type: "image/png" }))), "UNREADABLE_IMAGE");
      });
      it("uploading after creation refuses when no GM is online (A5)", async function() {
        this.timeout(30_000);
        assert.notExists(game.users.activeGM, "this batch needs no GM online");
        const { uploadPortrait } = await import("../scripts/portrait/upload.mjs");
        const out = await P.preparePortrait(await S.makeTestImage(200, 200));
        assert.equal(await code(uploadPortrait(`Actor.${foundry.utils.randomID()}`, out)), "GM_OFFLINE");
      });
    });
  }, { displayName: "Character Creator: Portrait (player side)" });

  // The relay: player → active GM → document-scoped upload → img, token texture and ring (D22).
  quench.registerBatch(`${MODULE_ID}.portrait@gm`, ({ describe, it, before, after, assert }) => {
    describe("Portrait: relay through the active GM", () => {
      let uploadPortrait;
      let actor;
      let image;
      let first;
      let second;
      let writes;
      const ring = { ring: "#c9a227", background: "#1b2a49", effects: 3 };
      const gm = () => game.users.activeGM;
      const query = (name, data) => gm().query(name, data, { timeout: 60_000 });
      const status = async path => (await fetch(`/${path}`, { cache: "no-store" })).status;
      const waitFor = async (fn, ms = 10_000) => {
        const end = Date.now() + ms;
        while ( Date.now() < end ) {
          const v = await fn();
          if ( v ) return v;
          await new Promise(r => setTimeout(r, 150));
        }
        return null;
      };

      before(async function() {
        this.timeout(60_000);
        assert.exists(gm(), "no active GM — run with npm run test:foundry");
        ({ uploadPortrait } = await import("../scripts/portrait/upload.mjs"));
        const { preparePortrait } = await import("../scripts/portrait/prepare.mjs");
        const S = await import("./support.mjs");
        await query(SUBMIT_TEST_QUERIES.CLEANUP, {});
        const uuid = await query(MAKE_ACTOR, { owned: true });
        actor = await waitFor(() => fromUuidSync(uuid));
        image = await preparePortrait(await S.makeTestImage(1600, 1600));
      });
      after(async function() {
        this.timeout(30_000);
        if ( gm() ) await query(SUBMIT_TEST_QUERIES.CLEANUP, {});
      });

      it("the player has no upload permission of their own", () => {
        assert.isFalse(game.user.can("FILES_UPLOAD"));
        assert.isFalse(game.user.can("FILES_BROWSE"));
      });
      it("the GM saves the portrait under the actor's asset path; the player's client writes nothing", async function() {
        this.timeout(60_000);
        const S = await import("./support.mjs");
        const stop = S.watchDb();
        first = await uploadPortrait(actor.uuid, image, ring);
        writes = stop();
        assert.isTrue(first.ok, JSON.stringify(first));
        assert.match(first.path, new RegExp(`^worlds/${game.world.id}/assets/actors/${actor.id}-[A-Za-z0-9]+\\.webp$`));
        assert.deepEqual(writes, []);
      });
      it("the file is served to the player, byte for byte", async () => {
        const res = await fetch(`/${first.path}`, { cache: "no-store" });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type") ?? "", /image\/webp/);
        assert.equal((await res.arrayBuffer()).byteLength, bytesOf(image));
      });
      it("img, token texture and ring all point at it, with the chosen colors and effects", async () => {
        assert.isTrue(!!(await waitFor(() => actor.img === first.path)), `img is ${actor.img}`);
        const t = actor.prototypeToken;
        assert.equal(t.texture.src, first.path);
        assert.isTrue(t.ring.enabled);
        assert.equal(t.ring.subject.texture, first.path);
        assert.equal(t.ring.colors.ring.css, ring.ring);
        assert.equal(t.ring.colors.background.css, ring.background);
        assert.equal(t.ring.effects, ring.effects);
      });
      it("refuses an actor the player doesn't own", async () => {
        const uuid = await query(MAKE_ACTOR, { owned: false });
        const res = await uploadPortrait(uuid, image, ring);
        assert.deepEqual(res.errors.map(e => e.code), ["NOT_OWNER"]);
      });
      it("refuses tampered images: wrong type or size (payload check), wrong signature or dimensions (GM decode)", async () => {
        const cases = [
          [{ ...image, mime: "image/png" }, "BAD_REQUEST"],
          [{ ...image, data: btoa("x".repeat(600 * 1024)) }, "BAD_REQUEST"],
          [{ ...image, data: btoa(`GIF89a${"x".repeat(100)}`) }, "BAD_IMAGE"],
          // A plausible but wrong size passes the payload check; the GM's decode catches it.
          [{ ...image, width: image.width - 1 }, "BAD_IMAGE"]
        ];
        for ( const [img, want] of cases ) {
          const res = await uploadPortrait(actor.uuid, img, ring);
          assert.deepEqual(res.errors.map(e => e.code), [want]);
        }
        assert.equal(actor.img, first.path, "unchanged");
      });
      it("a second upload gets a new file name (no stale cache) and the actor follows it", async function() {
        this.timeout(60_000);
        const { preparePortrait } = await import("../scripts/portrait/prepare.mjs");
        const S = await import("./support.mjs");
        second = await uploadPortrait(actor.uuid, await preparePortrait(await S.makeTestImage(800, 1200)), ring);
        assert.isTrue(second.ok);
        assert.notEqual(second.path, first.path);
        assert.isTrue(!!(await waitFor(() => actor.img === second.path)));
        assert.equal(await status(first.path), 200, "the previous file stays until the actor is deleted");
      });
      it("deleting the actor deletes its uploaded files (server-side)", async function() {
        this.timeout(30_000);
        await query(SUBMIT_TEST_QUERIES.CLEANUP, {});
        const gone = await waitFor(async () => (await status(first.path)) === 404 && (await status(second.path)) === 404);
        assert.isTrue(!!gone, "uploaded portraits still served after the actor was deleted");
      });
    });
  }, { displayName: "Character Creator: Portrait relay" });
}

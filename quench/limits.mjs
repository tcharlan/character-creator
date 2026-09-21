import { MODULE_ID } from "../scripts/main.mjs";

/*
 * The folder new characters go into (PLAN 4.4, DESIGN.md → Settings). Runs on the GM, whose browser is the one
 * that makes folders and characters (D13).
 */

const NAME = "Character Creator folder test";
const PARENT = "Character Creator folder parent";

export function registerLimitsBatches(quench) {
  quench.registerBatch(`${MODULE_ID}.folders@gmpage`, ({ describe, it, before, after, afterEach, assert }) => {
    describe("The character folder (scripts/gm/create), on the GM", () => {
      let ensureFolder;
      const made = () => game.folders.filter(f => (f.type === "Actor") && [NAME, PARENT].includes(f.name));
      const clear = async () => {
        const ids = made().map(f => f.id);
        if ( ids.length ) await foundry.utils.getDocumentClass("Folder").deleteDocuments(ids);
      };

      before(async function() {
        this.timeout(60_000);
        assert.isTrue(game.user.isGM, "folders are the GM's to make");
        ({ ensureFolder } = await import("../scripts/gm/create.mjs"));
        await clear();
      });
      afterEach(async function() {
        this.timeout(60_000);
        await clear();
      });
      after(async function() {
        this.timeout(60_000);
        await clear();
      });

      it("makes the folder when it's missing, and uses the same one after that", async function() {
        this.timeout(60_000);
        const first = await ensureFolder(NAME);
        assert.exists(first);
        assert.equal(first.name, NAME);
        assert.equal(first.type, "Actor");
        const second = await ensureFolder(NAME);
        assert.equal(second.id, first.id, "a second character shouldn't make a second folder");
        assert.lengthOf(made().filter(f => f.name === NAME), 1);
      });

      it("uses a folder of that name wherever the GM has put it", async function() {
        this.timeout(60_000);
        const Folder = foundry.utils.getDocumentClass("Folder");
        const parent = await Folder.create({ name: PARENT, type: "Actor" });
        const nested = await Folder.create({ name: NAME, type: "Actor", folder: parent.id });
        const found = await ensureFolder(NAME);
        assert.equal(found.id, nested.id, "a tidied-away folder is still the folder");
        assert.lengthOf(made().filter(f => f.name === NAME), 1, "and no second one at the top");
      });

      it("prefers the top-level one when there are several, and asks for none when the setting is empty", async function() {
        this.timeout(60_000);
        const Folder = foundry.utils.getDocumentClass("Folder");
        const parent = await Folder.create({ name: PARENT, type: "Actor" });
        await Folder.create({ name: NAME, type: "Actor", folder: parent.id });
        const top = await Folder.create({ name: NAME, type: "Actor" });
        assert.equal((await ensureFolder(NAME)).id, top.id);
        assert.isNull(await ensureFolder(""));
        assert.isNull(await ensureFolder("   "), "a setting of spaces is no folder, not a folder named ' '");
        assert.isNull(await ensureFolder(null));
      });
    });
  }, { displayName: "Character Creator: Character folder (GM)" });
}

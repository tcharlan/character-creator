import { MODULE_ID } from "../scripts/main.mjs";

/** Rules version each test world is expected to use (TESTING.md → Environments). */
const WORLD_RULES = {
  "legacy-test": "legacy",
  "modern-test": "modern"
};

/** dnd5e packs each rule set's tests depend on (TESTING.md → Environments). */
const EXPECTED_PACKS = {
  legacy: ["classes", "subclasses", "classfeatures", "races", "backgrounds", "items", "spells"],
  modern: ["classes24", "origins24", "feats24", "spells24", "equipment24"]
};

/**
 * Phase 0 smoke test: the module is loaded against a supported dnd5e in a correctly set up test world.
 * @param {object} quench  The Quench API.
 */
export function registerHelloBatch(quench) {
  quench.registerBatch(`${MODULE_ID}.hello`, context => {
    const { describe, it, assert } = context;

    describe("Environment", () => {
      it("module is active", () => {
        assert.isTrue(game.modules.get(MODULE_ID)?.active);
      });

      it("runs on Foundry v14 or later", () => {
        assert.isAtLeast(Number(game.release.generation), 14);
      });

      it("runs on dnd5e 5.3.0 or later", () => {
        assert.equal(game.system.id, "dnd5e");
        assert.isFalse(foundry.utils.isNewerVersion("5.3.0", game.system.version),
          `dnd5e ${game.system.version} is older than 5.3.0`);
      });

      it("world uses the rules version its name says", function() {
        const expected = WORLD_RULES[game.world.id];
        if ( !expected ) this.skip();
        assert.equal(game.settings.get("dnd5e", "rulesVersion"), expected);
      });

      it("the rule set's SRD packs are installed", function() {
        const expected = WORLD_RULES[game.world.id];
        if ( !expected ) this.skip();
        const missing = EXPECTED_PACKS[expected].filter(name => !game.packs.get(`dnd5e.${name}`));
        assert.deepEqual(missing, []);
      });
    });
  }, { displayName: "Character Creator: Hello" });
}

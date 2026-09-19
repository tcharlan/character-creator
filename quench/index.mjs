import { registerHelloBatch } from "./hello.mjs";
import { registerSpikeBatches } from "./spikes.mjs";
import { registerPhase1Batch } from "./phase1.mjs";
import { registerCatalogBatches, registerCatalogTestQueries } from "./catalog.mjs";
import { registerRulesBatches } from "./rules.mjs";
import { registerAbilityBatches, registerAbilityTestQueries } from "./abilities.mjs";
import { registerEquipmentBatches, registerEquipmentTestQueries } from "./equipment.mjs";
import { registerSpellBatches } from "./spells.mjs";
import { registerValidatorBatches, registerValidatorTestQueries } from "./validator.mjs";
import { registerSubmitBatches, registerSubmitTestQueries } from "./submit.mjs";
import { registerSpikeQueries } from "../spike/submit.mjs";
import { registerPortraitQueries } from "../spike/portrait.mjs";
import { registerPhase1Queries } from "../spike/phase1.mjs";

/**
 * Register every Quench batch for this module, plus the test-only query handlers they need.
 * Batch keys ending in "@gm" need a GM online; `npm run test:foundry` opens a GM session for them.
 * @param {object} quench  The Quench API passed to the "quenchReady" hook.
 */
export function registerQuenchBatches(quench) {
  registerSpikeQueries();
  registerPortraitQueries();
  registerPhase1Queries();
  registerCatalogTestQueries();
  registerAbilityTestQueries();
  registerEquipmentTestQueries();
  registerValidatorTestQueries();
  registerSubmitTestQueries();
  registerHelloBatch(quench);
  registerSpikeBatches(quench);
  registerPhase1Batch(quench);
  registerCatalogBatches(quench);
  registerRulesBatches(quench);
  registerAbilityBatches(quench);
  registerEquipmentBatches(quench);
  registerSpellBatches(quench);
  registerValidatorBatches(quench);
  registerSubmitBatches(quench);
}

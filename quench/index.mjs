import { registerHelloBatch } from "./hello.mjs";
import { registerPendingBatches } from "./pending.mjs";
import { registerDraftStoreBatches } from "./draft-store.mjs";
import { registerSettingsBatches, registerSettingsTestQueries } from "./settings.mjs";
import { registerPhase2Batch } from "./phase2.mjs";
import { registerPortraitBatches, registerPortraitTestQueries } from "./portrait.mjs";
import { registerSpeciesBatch } from "./species.mjs";
import { registerArtBatch } from "./art.mjs";
import { registerWizardBatches, registerOptionStepBatches, registerAbilityStepBatch, registerChoicesStepBatch, registerEquipmentStepBatch, registerSpellsStepBatch, registerDetailsStepBatch, registerPortraitStepBatch, registerCreateBatches } from "./wizard.mjs";
import { registerCatalogBatches, registerCatalogTestQueries } from "./catalog.mjs";
import { registerRulesBatches } from "./rules.mjs";
import { registerAbilityBatches, registerAbilityTestQueries } from "./abilities.mjs";
import { registerEquipmentBatches, registerEquipmentTestQueries } from "./equipment.mjs";
import { registerSpellBatches } from "./spells.mjs";
import { registerValidatorBatches, registerValidatorTestQueries } from "./validator.mjs";
import { registerSubmitBatches, registerSubmitTestQueries } from "./submit.mjs";

/**
 * Register every Quench batch for this module, plus the test-only query handlers they need.
 * Batch keys ending in "@gm" need a GM online; `npm run test:foundry` opens a GM session for them.
 * @param {object} quench  The Quench API passed to the "quenchReady" hook.
 */
export function registerQuenchBatches(quench) {
  registerCatalogTestQueries();
  registerAbilityTestQueries();
  registerEquipmentTestQueries();
  registerValidatorTestQueries();
  registerSubmitTestQueries();
  registerSettingsTestQueries();
  registerPortraitTestQueries();
  // First: pending@gm must be the first GM batch (see quench/pending.mjs).
  registerPendingBatches(quench);
  registerHelloBatch(quench);
  registerCatalogBatches(quench);
  registerRulesBatches(quench);
  registerAbilityBatches(quench);
  registerEquipmentBatches(quench);
  registerSpellBatches(quench);
  registerValidatorBatches(quench);
  registerSubmitBatches(quench);
  registerDraftStoreBatches(quench);
  registerSettingsBatches(quench);
  registerPortraitBatches(quench);
  registerSpeciesBatch(quench);
  registerArtBatch(quench);
  registerWizardBatches(quench);
  registerOptionStepBatches(quench);
  registerAbilityStepBatch(quench);
  registerChoicesStepBatch(quench);
  registerEquipmentStepBatch(quench);
  registerSpellsStepBatch(quench);
  registerDetailsStepBatch(quench);
  registerPortraitStepBatch(quench);
  registerCreateBatches(quench);
  registerPhase2Batch(quench);
}

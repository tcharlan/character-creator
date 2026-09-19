import { registerHelloBatch } from "./hello.mjs";
import { registerSpikeBatches } from "./spikes.mjs";
import { registerPhase1Batch } from "./phase1.mjs";
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
  registerHelloBatch(quench);
  registerSpikeBatches(quench);
  registerPhase1Batch(quench);
}

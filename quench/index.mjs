import { registerHelloBatch } from "./hello.mjs";
import { registerSpikeBatches } from "./spikes.mjs";
import { registerSpikeQueries } from "../spike/submit.mjs";

/**
 * Register every Quench batch for this module, plus the test-only query handlers they need.
 * Batch keys ending in "@gm" need a GM online; `npm run test:foundry` opens a GM session for them.
 * @param {object} quench  The Quench API passed to the "quenchReady" hook.
 */
export function registerQuenchBatches(quench) {
  registerSpikeQueries();
  registerHelloBatch(quench);
  registerSpikeBatches(quench);
}

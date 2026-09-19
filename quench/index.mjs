import { registerHelloBatch } from "./hello.mjs";
import { registerSpikeBatches } from "./spikes.mjs";

/**
 * Register every Quench batch for this module.
 * @param {object} quench  The Quench API passed to the "quenchReady" hook.
 */
export function registerQuenchBatches(quench) {
  registerHelloBatch(quench);
  registerSpikeBatches(quench);
}

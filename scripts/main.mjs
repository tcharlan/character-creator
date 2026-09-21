/**
 * Character Creator — entry point.
 * Registers settings, queries and UI entry points as later phases add them.
 */

import { MODULE_ID } from "./contracts.mjs";
import { registerSettings } from "./settings/settings.mjs";
import { registerCatalogHooks } from "./catalog/catalog.mjs";
import { registerGmQueries } from "./gm/submit.mjs";
import { registerPendingProcessor } from "./gm/pending.mjs";
import { registerWizardApi, preloadWizardTemplates } from "./wizard/app.mjs";
import { registerEntryPoints } from "./ui/entry-ui.mjs";

export { MODULE_ID };

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);
  registerSettings();
  registerCatalogHooks();
  registerGmQueries();
  registerPendingProcessor();
});

Hooks.once("ready", () => {
  registerWizardApi();
  preloadWizardTemplates();
  registerEntryPoints();
});

// In-Foundry integration tests; only loaded when the Quench module is active. A release leaves the batches
// out (they create and delete characters), so their absence is expected, not an error.
Hooks.once("quenchReady", async quench => {
  let batches;
  try {
    batches = await import("../quench/index.mjs");
  } catch {
    return;
  }
  batches.registerQuenchBatches(quench);
});

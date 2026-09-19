/**
 * Character Creator — entry point.
 * Registers settings, queries and UI entry points as later phases add them.
 */

export const MODULE_ID = "character-creator";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);
});

// In-Foundry integration tests; only loaded when the Quench module is active.
Hooks.once("quenchReady", async quench => {
  const { registerQuenchBatches } = await import("../quench/index.mjs");
  registerQuenchBatches(quench);
});

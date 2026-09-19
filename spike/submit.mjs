/*
 * SPIKE 1.4 — throwaway. Not part of the module (registered only by the Quench suites).
 *
 * Question: the end-to-end write path with real permissions. A Player-role user submits a recipe with
 * `User#query`; the active GM's browser replays and validates it (spike 1.3), creates the actor with its
 * items, gives the player ownership and assigns it as their character. Only the GM writes (D13).
 */

import { replay } from "./replay.mjs";

const MODULE_ID = "character-creator";
export const SUBMIT = `${MODULE_ID}.spikeSubmit`;
export const CLEANUP = `${MODULE_ID}.spikeCleanup`;
const SPIKE_FLAG = "spike14";

/** Register the query handlers. Every client needs the names (User#query checks CONFIG.queries). */
export function registerSpikeQueries() {
  CONFIG.queries[SUBMIT] = handleSubmit;
  CONFIG.queries[CLEANUP] = handleCleanup;
}

const isActiveGM = () => game.user.isGM && game.users.activeGM?.isSelf;

/**
 * GM side: validate by replay, then create.
 * @param {{ recipe: object, draftId: string, name?: string }} data
 * @param {{ user: User }} context  `user` is the sender, as identified by the server
 */
async function handleSubmit(data, { user }) {
  if ( !isActiveGM() ) throw new Error("Only the active GM handles submissions");
  const started = performance.now();
  const { recipe, draftId, name } = data ?? {};
  if ( typeof draftId !== "string" || !draftId || !recipe?.steps ) {
    return { ok: false, errors: [{ code: "BAD_REQUEST" }] };
  }

  // Idempotency: one actor per draft.
  const existing = game.actors.find(a => a.getFlag(MODULE_ID, "draftId") === draftId);
  if ( existing ) return { ok: true, actorUuid: existing.uuid, duplicate: true };

  const rules = game.settings.get("dnd5e", "rulesVersion");
  if ( recipe.rules !== rules ) {
    return { ok: false, errors: [{ code: "RULES_MISMATCH", detail: { recipe: recipe.rules, world: rules } }] };
  }

  // Never trust the player's values: rebuild from the recipe and validate every step.
  const { actor, errors } = await replay(recipe);
  if ( errors.length ) return { ok: false, errors };
  const replayMs = Math.round(performance.now() - started);

  const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const actorData = actor.toObject();
  delete actorData._id;
  actorData.name = (typeof name === "string" && name.trim()) || `${user.name}'s character`;
  actorData.ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, [user.id]: OWNER };
  foundry.utils.setProperty(actorData, `flags.${MODULE_ID}`, { draftId, [SPIKE_FLAG]: true });

  const windowsBefore = new Set(foundry.applications.instances.keys());
  const created = await Actor.implementation.create(actorData, { keepEmbeddedIds: true });
  if ( !user.character ) await user.update({ character: created.id });

  // Did creating the actor open anything (e.g. an AdvancementManager)? It must not.
  await new Promise(r => setTimeout(r, 250));
  const opened = [...foundry.applications.instances.values()]
    .filter(app => !windowsBefore.has(app.id)).map(app => app.constructor.name);

  return {
    ok: true, actorUuid: created.uuid,
    diagnostics: { replayMs, totalMs: Math.round(performance.now() - started), items: created.items.size, opened }
  };
}

/** GM side: delete actors created by this spike and clear any character assignment pointing at them. */
async function handleCleanup() {
  if ( !isActiveGM() ) throw new Error("Only the active GM cleans up");
  const actors = game.actors.filter(a => a.getFlag(MODULE_ID, SPIKE_FLAG));
  const ids = new Set(actors.map(a => a.id));
  for ( const u of game.users.filter(u => ids.has(u.character?.id)) ) await u.update({ character: null });
  if ( ids.size ) await Actor.implementation.deleteDocuments([...ids]);
  return { deleted: ids.size };
}

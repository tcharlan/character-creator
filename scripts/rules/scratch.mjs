/**
 * The scratch actor: an unsaved dnd5e character the recipe is applied to (D12), in the player's
 * browser for the preview and in the GM's for validation and creation.
 */

import { ABILITIES } from "../contracts.mjs";

const POINTER = { species: "system.details.race", background: "system.details.background",
  class: "system.details.originalClass" };

/**
 * A new scratch character. Built from a `toObject()` copy of a first construction: a
 * default-constructed actor shares arrays with the schema's `initial` values (dnd5e trait SetFields
 * use one `[]` literal, Foundry returns non-function initials uncloned and ArrayField updates in
 * place — RESEARCH.md → Spike 1.2), so this one must own fresh copies.
 * @param {Record<string, number>|null} base  Base ability scores (null: all 10).
 * @param {object} [options]
 * @param {string} [options.userId]  Owner (for permission-sensitive dnd5e logic in the player's browser).
 */
export function makeScratchActor(base, { userId = game.user?.id, name = "Character Creator scratch" } = {}) {
  const abilities = Object.fromEntries(ABILITIES.map(k => [k, { value: base?.[k] ?? 10 }]));
  const ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE };
  if ( userId ) ownership[userId] = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const seed = new Actor.implementation({ type: "character", name, ownership, system: { abilities } });
  return new Actor.implementation(seed.toObject());
}

/** Embed a compendium document as a new item; returns the embedded item. */
export function embedItem(actor, doc, overrides = {}) {
  const data = game.items.fromCompendium(doc);
  data._id = foundry.utils.randomID();
  for ( const [path, value] of Object.entries(overrides) ) foundry.utils.setProperty(data, path, value);
  actor.updateSource({ items: [data] });
  return actor.items.get(data._id);
}

/**
 * Embed the picked species, background and class. The class starts at level 1. The actor's
 * `details.race` / `details.background` / `details.originalClass` point at them: dnd5e sets these
 * only in its create hooks (real creates), and derives movement, senses and creature type from
 * `details.race` (RESEARCH.md → Spike 1.8).
 * @param {Actor} actor
 * @param {{ species: string|null, background: string|null, class: string|null }} picks  UUIDs.
 * @returns {Promise<{ roots: Record<string, string>, missing: string[], unknown: string[] }>}
 *   `roots`: role → embedded item id; `missing`: roles not picked; `unknown`: roles whose UUID didn't resolve.
 */
export async function embedPicks(actor, picks) {
  const roots = {};
  const missing = [];
  const unknown = [];
  for ( const role of ["species", "background", "class"] ) {
    const uuid = picks?.[role];
    if ( !uuid ) {
      missing.push(role);
      continue;
    }
    const doc = await fromUuid(uuid);
    const expected = { species: "race", background: "background", class: "class" }[role];
    if ( !doc || doc.type !== expected ) {
      unknown.push(role);
      continue;
    }
    const item = embedItem(actor, doc, role === "class" ? { "system.levels": 1 } : {});
    actor.updateSource({ [POINTER[role]]: item.id });
    roots[role] = item.id;
  }
  actor.reset();
  return { roots, missing, unknown };
}

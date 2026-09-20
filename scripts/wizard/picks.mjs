/**
 * Changing a pick (PLAN 3.2). Pure: when the player swaps their species, class or background, the answers that
 * belonged to the old one are dropped, along with anything downstream that can no longer apply — otherwise a
 * stale answer would sit in the recipe and be rejected at submit time.
 */

import { ROLES } from "../contracts.mjs";
import { parseSegment } from "../rules/paths.mjs";

/** What else depends on a role: changing the class also drops its equipment and the class's spells. */
const DEPENDENTS = Object.freeze({
  species: { equipment: [], spells: false },
  background: { equipment: ["background"], spells: false },
  class: { equipment: ["class"], spells: true }
});

/** Recipe steps that belong to a role (their path starts with it). */
export const stepsForRole = (draft, role) => (draft?.recipe?.steps ?? []).filter(s => s.path?.[0] === role);

/**
 * Set a pick and clear what it invalidates. Returns the draft (mutated in place, as the store's `update` expects).
 * @param {object} draft
 * @param {"species"|"background"|"class"} role
 * @param {string|null} uuid
 */
export function applyPick(draft, role, uuid) {
  if ( !ROLES.includes(role) ) throw new Error(`Unknown role "${role}"`);
  if ( draft.picks[role] === uuid ) return draft;
  draft.picks[role] = uuid;
  draft.recipe.steps = (draft.recipe.steps ?? []).filter(s => s.path?.[0] !== role);
  const dependents = DEPENDENTS[role];
  for ( const source of dependents.equipment ) draft.equipment[source] = null;
  if ( dependents.spells ) draft.spells = { cantrips: [], spells: [], spellbook: [] };
  return draft;
}

/** The answer for one advancement step, replacing any earlier answer for it. */
export function answerStep(draft, { path, advancementId, level }, data) {
  const same = s => s.advancementId === advancementId && s.level === level && s.path.join(">") === path.join(">");
  draft.recipe.steps = [...draft.recipe.steps.filter(s => !same(s)), { path: [...path], advancementId, level, data }];
  return draft;
}

/** The UUID picked for an item, from a recipe step's path segment (for showing what's chosen). */
export const pickedUuid = segment => parseSegment(segment)?.uuid ?? null;

/**
 * Multiclassing prerequisites (D35, D37). Pure: no Foundry globals.
 *
 * Rules gap (convention 2): dnd5e's class data says which abilities a class's prerequisite is on
 * (`system.primaryAbility.value`, and `.all` for "and" rather than "or"), but not the score.
 * Source: 2014 PHB, chapter 6 "Multiclassing" → Prerequisites ("To qualify for a new class, you must meet the
 * ability score prerequisites for both your current class and your new one", 13 in each, e.g. "Strength 13 or
 * Dexterity 13" for a Fighter, "Dexterity 13 and Wisdom 13" for a Monk); 2024 PHB, chapter 2 "Multiclassing" →
 * Prerequisites ("a score of at least 13 in the primary ability of your current classes and your new class").
 */

import { makeError } from "../contracts.mjs";

export const MULTICLASS_MINIMUM = 13;

/**
 * Rules gap: dnd5e's 2014 SRD classes carry no primary abilities (`primaryAbility.value` is empty in every
 * `dnd5e.classes` entry; the 2024 ones are filled in). Source: 2014 PHB, chapter 6 "Multiclassing", the
 * Multiclassing Prerequisites table. Used only when a class's own data names no ability, keyed by identifier.
 */
export const PHB_2014_PREREQUISITES = Object.freeze({
  barbarian: { abilities: ["str"], all: true },
  bard: { abilities: ["cha"], all: true },
  cleric: { abilities: ["wis"], all: true },
  druid: { abilities: ["wis"], all: true },
  fighter: { abilities: ["dex", "str"], all: false },
  monk: { abilities: ["dex", "wis"], all: true },
  paladin: { abilities: ["cha", "str"], all: true },
  ranger: { abilities: ["dex", "wis"], all: true },
  rogue: { abilities: ["dex"], all: true },
  sorcerer: { abilities: ["cha"], all: true },
  warlock: { abilities: ["cha"], all: true },
  wizard: { abilities: ["int"], all: true }
});

/**
 * A class's prerequisite: its own primary abilities (dnd5e `system.primaryAbility`, "or" unless `all`), or the
 * 2014 PHB table for a class whose data names none.
 * @param {string} identifier
 * @param {{ value?: Iterable<string>, all?: boolean }} [primaryAbility]
 * @returns {{ abilities: string[], all: boolean }}
 */
export function prerequisiteFor(identifier, primaryAbility) {
  const abilities = [...(primaryAbility?.value ?? [])].sort();
  if ( abilities.length ) return { abilities, all: !!primaryAbility.all };
  return PHB_2014_PREREQUISITES[identifier] ?? { abilities: [], all: true };
}

/**
 * Does a set of scores meet a class's prerequisite?
 * @param {{ abilities: string[], all: boolean }} primary   The class's primary abilities.
 * @param {Record<string, number>} scores
 */
export function meetsPrerequisite(primary, scores) {
  const abilities = primary?.abilities ?? [];
  if ( !abilities.length ) return true;   // a class with no primary ability asks for nothing
  const ok = a => (scores?.[a] ?? 0) >= MULTICLASS_MINIMUM;
  return primary.all ? abilities.every(ok) : abilities.some(ok);
}

/**
 * Check every class the character joined after the first (D37: in class order, with the scores it had then).
 * @param {{ root: string, name?: string, primary: object, scores: Record<string, number>, held: object[] }[]} joins
 *   Each other class as it was added: its primary abilities, the scores at that point, and the primary abilities
 *   of the classes already held (`[{ root, name, primary }]`).
 * @returns {object[]} makeError() objects (MULTICLASS_PREREQUISITES)
 */
export function checkMulticlassPrerequisites(joins = []) {
  const errors = [];
  for ( const join of joins ) {
    const missing = [join, ...(join.held ?? [])].filter(c => !meetsPrerequisite(c.primary, join.scores))
      .map(c => ({ class: c.root, name: c.name ?? null, abilities: c.primary?.abilities ?? [], all: !!c.primary?.all }));
    if ( missing.length ) errors.push(makeError("MULTICLASS_PREREQUISITES", { joining: join.root, missing }));
  }
  return errors;
}

/**
 * Which classes a character with these scores could take next (the wizard's list, the hardcore shortlist):
 * those whose prerequisite the scores meet, provided the classes already held meet theirs too.
 * @param {{ uuid: string, primary: object }[]} candidates
 * @param {object[]} held     `{ primary }` of every class already taken.
 * @param {Record<string, number>} scores
 * @returns {string[]} the UUIDs that qualify
 */
export function qualifyingClasses(candidates, held, scores) {
  if ( !held.every(c => meetsPrerequisite(c.primary, scores)) ) return [];
  return candidates.filter(c => meetsPrerequisite(c.primary, scores)).map(c => c.uuid);
}

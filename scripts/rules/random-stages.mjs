/**
 * The stages of a random character above level 1 (D35, D36, D39), Foundry side: the GM's settings turned into
 * the loop's stage configuration, and the classes a character could multiclass into. The player's browser and the
 * GM's replay both use this, so both offer the same lists.
 */

import { normalizeUuid } from "../catalog/filters.mjs";
import { buildCharacter, buildInput } from "./build.mjs";
import { prerequisiteFor, qualifyingClasses } from "./multiclass.mjs";

/**
 * The classes a character could take as a second class (D35): every allowed class other than its first, and —
 * where the GM respects the prerequisites — only those its level-1 scores qualify for, its first class's own
 * prerequisite included.
 * @param {object} draft
 * @param {object} catalog
 * @param {{ prerequisites: boolean }} rules     The GM's level settings.
 * @returns {Promise<string[]>} UUIDs
 */
export async function multiclassCandidates(draft, catalog, { prerequisites = true } = {}) {
  const atOne = await buildCharacter(buildInput({ ...draft, level: 1, multiclass: [] }), { catalog, fill: true });
  const first = atOne.actor.items.get(atOne.roots.class);
  if ( !first ) return [];
  const candidates = (catalog.byCategory.class ?? [])
    .filter(e => e.system?.identifier && (e.system.identifier !== first.system.identifier))
    .map(e => ({ uuid: normalizeUuid(e.uuid), primary: prerequisiteFor(e.system.identifier, e.system.primaryAbility) }));
  if ( !prerequisites ) return candidates.map(c => c.uuid);
  const scores = Object.fromEntries(Object.entries(atOne.actor.system.abilities).map(([k, a]) => [k, a.value]));
  return qualifyingClasses(candidates, [{ primary: prerequisiteFor(first.system.identifier, first.system.primaryAbility) }], scores);
}

/**
 * The loop's stage configuration from the settings.
 * @param {{ hardcore: object, levels: object }} settings   readSettings()
 * @param {object} catalog
 */
export function stageConfig(settings, catalog) {
  const h = settings.hardcore;
  const l = settings.levels;
  return {
    subclass: { size: h.subclassChoices },
    feats: { mode: h.feats, size: h.featChoices },
    multiclass: l.multiclass
      ? { size: h.multiclassChoices, firstMinimum: l.firstClassLevels ?? 1,
        candidates: draft => multiclassCandidates(draft, catalog, { prerequisites: l.prerequisites }) }
      : null
  };
}

/**
 * Build a character from its recipe (D18: every change rebuilds; convention 9: the GM replays the same
 * recipe). Used by the wizard (preview, which steps need attention) and the GM's validator (errors).
 *
 * Order (spikes 1.2/1.3): species, background, class, then the subclass the class granted, then any
 * granted item with advancements of its own, in the order they were added. Species and background
 * advance at levels 0–1, class and subclass at level 1. Equipment and spells are separate (PLAN 2.5).
 */

import { makeError } from "../contracts.mjs";
import { normalizeUuid } from "../catalog/filters.mjs";
import { makeScratchActor, embedPicks } from "./scratch.mjs";
import { KNOWN_TYPES, stepOptions, automaticData, checkBefore, checkAfter } from "./steps.mjs";
import { formatSegment, indexRecipe, stepKey, summarize } from "./paths.mjs";

const ROLE_ERRORS = {
  species: ["SPECIES_MISSING", "SPECIES_NOT_ALLOWED"],
  background: ["BACKGROUND_MISSING", "BACKGROUND_NOT_ALLOWED"],
  class: ["CLASS_MISSING", "CLASS_NOT_ALLOWED"]
};

/** Path of an item on the actor (see paths.mjs). */
export function itemPath(actor, itemId, roots) {
  const role = Object.entries(roots).find(([, id]) => id === itemId)?.[0];
  if ( role ) return [role];
  const item = actor.items.get(itemId);
  const uuid = item?._stats?.compendiumSource;
  const origin = item?.flags?.dnd5e?.advancementOrigin;
  if ( origin ) {
    const [parentId, advId] = origin.split(".");
    const parent = itemPath(actor, parentId, roots);
    return parent ? [...parent, formatSegment(advId, uuid)] : null;
  }
  // A subclass has no origin flag: its parent is the class Subclass advancement that points at it.
  for ( const cls of actor.items.filter(i => i.type === "class") ) {
    const adv = cls.advancement.byType.Subclass?.find(a => {
      const doc = a.value?.document;
      return (typeof doc === "string" ? doc : doc?.id) === itemId;
    });
    if ( adv ) {
      const parent = itemPath(actor, cls.id, roots);
      return parent ? [...parent, formatSegment(adv.id, uuid)] : null;
    }
  }
  return null;
}

/**
 * Build (replay) a character.
 * @param {object} input
 * @param {{ species, background, class }} input.picks         UUIDs.
 * @param {Record<string, number>|null} input.base               Base ability scores.
 * @param {object[]} [input.steps]                               Recipe steps `{ path, advancementId, level, data }`.
 * @param {object} options
 * @param {object} options.catalog                               From getCatalog().
 * @param {boolean} [options.fill=true]   Apply automatic data for steps missing from the recipe (the
 *   wizard). The GM's validator passes false: a complete recipe must contain every step.
 * @param {boolean} [options.withOptions=false]  Include each step's options (for the wizard's widgets).
 * @returns {Promise<{ actor, roots, results, recipe: { steps }, errors, summary, stale }>}
 */
export async function buildCharacter({ picks, base, steps = [] }, { catalog, fill = true, withOptions = false }) {
  const errors = [];
  const actor = makeScratchActor(base);
  const { roots, missing, unknown } = await embedPicks(actor, picks);
  for ( const role of missing ) errors.push(makeError(ROLE_ERRORS[role][0]));
  for ( const role of unknown ) errors.push(makeError("UNKNOWN_ITEM", { role, uuid: picks?.[role] }));
  for ( const [role, id] of Object.entries(roots) ) {
    const uuid = actor.items.get(id)?._stats?.compendiumSource;
    if ( !catalog.get(uuid) ) errors.push(makeError(ROLE_ERRORS[role][1], { uuid }));
  }

  const { byKey, duplicates } = indexRecipe(steps);
  for ( const d of duplicates ) errors.push(makeError("BAD_REQUEST", { duplicateStep: d }));
  const used = new Set();
  const results = [];
  const recipe = [];
  const processed = new Set();

  const processItem = async (itemId, levels) => {
    processed.add(itemId);
    for ( const level of levels ) {
      const item = actor.items.get(itemId);
      const path = itemPath(actor, itemId, roots);
      for ( const { id } of (item?.advancement?.byLevel?.[level] ?? []).filter(a => a.appliesToClass) ) {
        const adv = actor.items.get(itemId).advancement.byId[id];
        await processStep(item, adv, level, path);
      }
    }
  };

  const processStep = async (item, adv, level, path) => {
    const key = stepKey({ path, advancementId: adv.id, level });
    const result = { key, path, advancementId: adv.id, level, type: adv.type, title: adv.title, item: item.name,
      itemId: item.id, status: null, data: null, errors: [] };
    if ( !KNOWN_TYPES.includes(adv.type) ) {
      result.status = "blocked";
      result.errors.push(makeError("UNKNOWN_ADVANCEMENT_TYPE", { type: adv.type, item: item.name }));
      results.push(result);
      return;
    }
    const opts = await stepOptions(adv, level, { actor, catalog });
    if ( opts === null ) return;   // nothing to pick at this level
    if ( withOptions ) result.options = opts;

    const stored = byKey.get(key);
    if ( stored ) used.add(key);
    let data = stored?.data;
    let auto = false;
    if ( !data && fill ) {
      data = await automaticData(adv, level, opts);
      auto = !!data;
    }
    if ( !data ) {
      result.status = "needsInput";
      if ( !fill ) result.errors.push(makeError("MISSING_STEP", { item: item.name, title: adv.title, type: adv.type, level }));
      results.push(result);
      return;
    }
    result.data = foundry.utils.deepClone(data);
    result.errors.push(...checkBefore(adv, level, data, opts));
    if ( result.errors.length ) {
      result.status = "invalid";
      results.push(result);
      return;
    }
    try {
      await adv.apply(level, foundry.utils.deepClone(data));
    } catch ( err ) {
      result.errors.push(makeError("APPLY_FAILED", { message: err.message }));
    }
    actor.reset();
    result.errors.push(...await checkAfter(actor.items.get(item.id)?.advancement.byId[adv.id]));
    result.status = result.errors.length ? "invalid" : auto ? "auto" : "done";
    results.push(result);
    if ( result.status !== "invalid" ) recipe.push({ path, advancementId: adv.id, level, data: result.data });
  };

  if ( roots.species ) await processItem(roots.species, [0, 1]);
  if ( roots.background ) await processItem(roots.background, [0, 1]);
  if ( roots.class ) {
    await processItem(roots.class, [1]);
    const subclass = actor.items.find(i => i.type === "subclass" && !processed.has(i.id));
    if ( subclass ) await processItem(subclass.id, [1]);
  }
  // Granted items with advancements of their own (lineage features, feats like Magic Initiate…).
  for ( let pass = 0; pass < 8; pass++ ) {
    const pending = actor.items.filter(i => !processed.has(i.id)
      && Object.values(i.advancement?.byLevel ?? {}).some(list => list.length));
    if ( !pending.length ) break;
    for ( const item of pending ) await processItem(item.id, item.type === "subclass" ? [1] : [0, 1]);
  }
  actor.reset();

  // Recipe steps that matched nothing (e.g. left over from a previous class): stale.
  const stale = [...byKey.entries()].filter(([k]) => !used.has(k)).map(([, s]) => s);
  for ( const s of stale ) {
    const e = makeError("UNKNOWN_ADVANCEMENT", { path: s.path, advancementId: s.advancementId, level: s.level });
    if ( !fill ) errors.push(e);
  }
  for ( const r of results ) errors.push(...r.errors);
  return { actor, roots, results, recipe: { steps: recipe }, errors, summary: summarize(results), stale };
}

/** Normalised compendium source of an item (for comparisons). */
export const sourceOf = item => normalizeUuid(item?._stats?.compendiumSource);

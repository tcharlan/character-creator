/**
 * Build a character from its recipe (D18: every change rebuilds; convention 9: the GM replays the same
 * recipe). Used by the wizard (preview, which steps need attention) and the GM's validator (errors).
 *
 * Level by level (D32, D38; Spike 8.0): at character level 1 exactly as a level-1 character always was —
 * species (levels 0–1), background (0–1), class (1), the subclass the class granted, then any granted item
 * with advancements of its own, in the order they were added. From level 2 on, one character level at a time:
 * the class that level belongs to is raised to it (a class taken by multiclassing is embedded at its first
 * level, D37: the first class's levels come first, then each other class's), and then every item catches up
 * on what that level brings — class and subclass advancements by class level, everything else by character
 * level. Each step therefore sees the character as it stood at that level: the spell levels it can cast,
 * dnd5e's level prerequisites, its scale values.
 *
 * A build can keep a copy of the scratch actor at the end of each level (`onLevel`) and later resume from one
 * (`from`), which replays only what a change touched; and it can hand the browser back control between steps
 * (`slice`), so a long replay never freezes the screen (D38, Spike 8.0b). Equipment and spells are separate.
 */

import { makeError, MULTICLASS_ROOT } from "../contracts.mjs";
import { normalizeUuid } from "../catalog/filters.mjs";
import { makeScratchActor, embedPicks, embedItem } from "./scratch.mjs";
import { KNOWN_TYPES, stepOptions, automaticData, checkBefore, checkAfter } from "./steps.mjs";
import { formatSegment, indexRecipe, stepKey, summarize } from "./paths.mjs";
import { prerequisiteFor } from "./multiclass.mjs";

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
 * Which class each character level goes to (D37, class order): the first class's levels, then each other
 * class's, in the draft's order. `schedule[c]` for c = 1…level is `{ root, classLevel }`.
 * @param {number} level
 * @param {{ uuid: string, levels: number, root: string }[]} others   Other classes, with their path roots.
 * @returns {({ root: string, classLevel: number }|null)[]}
 */
export function levelSchedule(level, others = []) {
  const schedule = [null];
  const firstLevels = Math.max(1, level - others.reduce((n, m) => n + (m.levels ?? 0), 0));
  for ( let k = 1; k <= firstLevels; k++ ) schedule.push({ root: "class", classLevel: k });
  for ( const m of others ) {
    for ( let k = 1; (k <= m.levels) && (schedule.length <= level); k++ ) schedule.push({ root: m.root, classLevel: k });
  }
  return schedule.slice(0, level + 1);
}

/** The draft's input to a build: what the replay depends on. */
export function buildInput(draft) {
  return { picks: draft.picks, base: draft.abilities?.base ?? null, steps: draft.recipe?.steps ?? [],
    level: draft.level ?? 1, multiclass: draft.multiclass ?? [], hitPoints: draft.hitPoints ?? { rolls: {} } };
}

/** Give the browser back control (a task, not a microtask, so it can draw and take clicks). */
const handBack = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Build (replay) a character.
 * @param {object} input                                         buildInput(draft), or the same by hand.
 * @param {{ species, background, class }} input.picks         UUIDs.
 * @param {Record<string, number>|null} input.base               Base ability scores.
 * @param {object[]} [input.steps]                               Recipe steps `{ path, advancementId, level, data }`.
 * @param {number} [input.level=1]                               Character level (D32).
 * @param {{ uuid: string, levels: number }[]} [input.multiclass] Other classes (D35, D37).
 * @param {{ rolls: object }} [input.hitPoints]                  Rolled hit dice by class level (D33).
 * @param {object} options
 * @param {object} options.catalog                               From getCatalog().
 * @param {boolean} [options.fill=true]   Apply automatic data for steps missing from the recipe (the
 *   wizard). The GM's validator passes false: a complete recipe must contain every step.
 * @param {boolean} [options.withOptions=false]  Include each step's options (for the wizard's widgets).
 * @param {"average"|"rolled"} [options.hitPointMethod="average"]  Hit points past the first level (D33).
 * @param {object} [options.from]       A checkpoint from `onLevel`: resume after its level (D38).
 * @param {(level: number, checkpoint: object) => void} [options.onLevel]  Called at the end of every level.
 * @param {boolean} [options.slice=false]  Hand the browser back control after every step (D38).
 * @param {AbortSignal} [options.signal]   Abandon the replay (a newer change came in); throws its reason.
 * @returns {Promise<{ actor, roots, results, recipe: { steps }, errors, summary, stale, joins }>}
 */
export async function buildCharacter({ picks, base, steps = [], level = 1, multiclass = [], hitPoints = null },
  { catalog, fill = true, withOptions = false, hitPointMethod = "average", from = null, onLevel = null, slice = false,
    signal = null } = {}) {
  const errors = [];
  const { byKey, duplicates } = indexRecipe(steps);
  for ( const d of duplicates ) errors.push(makeError("BAD_REQUEST", { duplicateStep: d }));

  // Other classes: their documents, roots and the level each character level goes to.
  const others = [];
  for ( const m of multiclass ?? [] ) {
    const doc = await fromUuid(m.uuid);
    if ( (doc?.type !== "class") || !doc.system?.identifier ) {
      errors.push(makeError("UNKNOWN_ITEM", { role: "class", uuid: m.uuid }));
      continue;
    }
    if ( !catalog.get(normalizeUuid(m.uuid)) ) errors.push(makeError("CLASS_NOT_ALLOWED", { uuid: normalizeUuid(m.uuid) }));
    others.push({ ...m, doc, root: `${MULTICLASS_ROOT}${doc.system.identifier}` });
  }
  const schedule = levelSchedule(level, others);

  let actor;
  let roots;
  let results;
  let recipe;
  let used;
  let done;
  let order;
  let start;
  // What embedding the picks found (missing, unknown, not allowed): kept with a checkpoint, since a resumed build
  // doesn't embed them again.
  let pickErrors = [];
  // Each other class as it joined: its primary abilities and the scores then, for the prerequisites (D35, D37).
  let joins = [];
  if ( from ) {
    actor = new Actor.implementation(foundry.utils.deepClone(from.data));
    roots = { ...from.roots };
    results = [...from.results];
    recipe = [...from.recipe];
    used = new Set(from.used);
    done = new Set(from.done);
    order = [...from.order];
    pickErrors = [...from.pickErrors];
    joins = foundry.utils.deepClone(from.joins ?? []);
    start = from.level + 1;
  } else {
    actor = makeScratchActor(base);
    const embedded = await embedPicks(actor, picks);
    roots = embedded.roots;
    for ( const role of embedded.missing ) pickErrors.push(makeError(ROLE_ERRORS[role][0]));
    for ( const role of embedded.unknown ) pickErrors.push(makeError("UNKNOWN_ITEM", { role, uuid: picks?.[role] }));
    for ( const [role, id] of Object.entries(roots) ) {
      const uuid = actor.items.get(id)?._stats?.compendiumSource;
      if ( !catalog.get(uuid) ) pickErrors.push(makeError(ROLE_ERRORS[role][1], { uuid }));
    }
    results = [];
    recipe = [];
    used = new Set();
    done = new Set();
    order = [roots.species, roots.background, roots.class].filter(Boolean);
    start = 1;
  }
  errors.push(...pickErrors);
  const hp = { method: hitPointMethod, rolls: hitPoints?.rolls ?? {} };

  const processStep = async (item, adv, lv, path, at) => {
    const key = stepKey({ path, advancementId: adv.id, level: lv });
    const result = { key, path, advancementId: adv.id, level: lv, at, type: adv.type, title: adv.title, item: item.name,
      itemId: item.id, status: null, data: null, errors: [] };
    if ( !KNOWN_TYPES.includes(adv.type) ) {
      result.status = "blocked";
      result.errors.push(makeError("UNKNOWN_ADVANCEMENT_TYPE", { type: adv.type, item: item.name }));
      results.push(result);
      return;
    }
    const opts = await stepOptions(adv, lv, { actor, catalog, hitPoints: hp });
    if ( opts === null ) return;   // nothing to pick at this level
    if ( withOptions ) result.options = opts;
    // Which hit die a level takes (D33): the wizard rolls the missing ones, the GM checks the rolls used.
    if ( adv.type === "HitPoints" ) Object.assign(result, { slot: opts.slot, faces: opts.faces });

    const stored = byKey.get(key);
    if ( stored ) used.add(key);
    let data = stored?.data;
    // An empty trait answer recorded automatically while there was nothing to choose (the 2024 Wizard's Scholar
    // before the background gave any of its skills) is no answer once there is: the wizard asks again. Only the
    // wizard's build does this; the GM's strict replay takes the recipe as it is.
    if ( fill && data && (adv.type === "Trait") && !(data.chosen?.length) && (opts.max > 0) && opts.allowed?.length ) {
      data = undefined;
    }
    // Hit points are never the player's to choose (D33): in the wizard, an answer left from another method (the
    // average, before the GM switched to rolling) gives way to what the method gives now.
    if ( fill && data && (adv.type === "HitPoints") && (JSON.stringify(data) !== JSON.stringify(opts.expected)) ) {
      data = undefined;
    }
    let auto = false;
    if ( !data && fill ) {
      data = await automaticData(adv, lv, opts);
      auto = !!data;
    }
    if ( !data ) {
      result.status = "needsInput";
      if ( !fill ) result.errors.push(makeError("MISSING_STEP", { item: item.name, title: adv.title, type: adv.type, level: lv }));
      results.push(result);
      return;
    }
    result.data = foundry.utils.deepClone(data);
    result.errors.push(...checkBefore(adv, lv, data, opts));
    if ( result.errors.length ) {
      result.status = "invalid";
      results.push(result);
      return;
    }
    try {
      await adv.apply(lv, foundry.utils.deepClone(data));
    } catch ( err ) {
      result.errors.push(makeError("APPLY_FAILED", { message: err.message }));
    }
    actor.reset();
    result.errors.push(...await checkAfter(actor.items.get(item.id)?.advancement.byId[adv.id]));
    result.status = result.errors.length ? "invalid" : auto ? "auto" : "done";
    results.push(result);
    if ( result.status !== "invalid" ) recipe.push({ path, advancementId: adv.id, level: lv, data: result.data });
  };

  // How far each item has got: a class by its levels, a subclass by its class's, anything else by the
  // character's level (character level 1 also covers level 0).
  const reach = (item, c) => {
    if ( item.type === "class" ) return item.system.levels ?? 1;
    if ( item.type === "subclass" ) {
      const cls = actor.items.find(i => (i.type === "class") && (i.system.identifier === item.system.classIdentifier));
      return cls?.system.levels ?? 1;
    }
    return c;
  };
  const levelsOf = (item, c) => Object.keys(item?.advancement?.byLevel ?? {}).map(Number)
    .filter(l => (["class", "subclass"].includes(item.type) ? l >= 1 : l >= 0) && (l <= reach(item, c)));

  for ( let c = start; c <= level; c++ ) {
    // The class this level belongs to grows by one (the first class is already at 1 for c = 1).
    const slot = schedule[c];
    if ( slot && (c > 1) ) {
      const other = others.find(o => o.root === slot.root);
      if ( other && !roots[slot.root] ) {
        const scores = Object.fromEntries(Object.entries(actor.system.abilities).map(([k, a]) => [k, a.value]));
        const held = Object.entries(roots).filter(([r]) => (r === "class") || r.startsWith(MULTICLASS_ROOT))
          .map(([r, id]) => ({ root: r, name: actor.items.get(id)?.name ?? null, primary: primaryOf(actor.items.get(id)) }));
        joins.push({ root: slot.root, name: other.doc.name, primary: primaryOf(other.doc), scores, held });
        const item = embedItem(actor, other.doc, { "system.levels": 1 });
        roots[slot.root] = item.id;
        order.push(item.id);
      } else if ( roots[slot.root] ) {
        actor.items.get(roots[slot.root]).updateSource({ "system.levels": slot.classLevel });
      }
      actor.reset();
    }
    for ( let pass = 0; pass < 12; pass++ ) {
      // New arrivals (a subclass, a feat, a lineage feature) join the order at the end, a subclass first.
      const fresh = actor.items.filter(i => !order.includes(i.id) && Object.keys(i.advancement?.byLevel ?? {}).length);
      order.push(...fresh.filter(i => i.type === "subclass").map(i => i.id), ...fresh.filter(i => i.type !== "subclass").map(i => i.id));
      let progressed = false;
      for ( const id of [...order] ) {
        const item = actor.items.get(id);
        if ( !item ) continue;
        for ( const l of levelsOf(item, c) ) {
          const mark = `${id}@${l}`;
          if ( done.has(mark) ) continue;
          done.add(mark);
          progressed = true;
          const path = itemPath(actor, id, roots);
          for ( const { id: advId } of (item.advancement.byLevel[l] ?? []).filter(a => a.appliesToClass) ) {
            const current = actor.items.get(id);
            await processStep(current, current.advancement.byId[advId], l, path, c);
            if ( slice ) await handBack();
            signal?.throwIfAborted();
          }
        }
      }
      if ( !progressed ) break;
    }
    onLevel?.(c, { level: c, data: actor.toObject(), roots: { ...roots }, results: [...results], recipe: [...recipe],
      used: [...used], done: [...done], order: [...order], pickErrors: [...pickErrors],
      joins: foundry.utils.deepClone(joins) });
  }
  actor.reset();

  // Recipe steps that matched nothing (e.g. left over from a previous class): stale.
  const stale = [...byKey.entries()].filter(([k]) => !used.has(k)).map(([, s]) => s);
  for ( const s of stale ) {
    const e = makeError("UNKNOWN_ADVANCEMENT", { path: s.path, advancementId: s.advancementId, level: s.level });
    if ( !fill ) errors.push(e);
  }
  for ( const r of results ) errors.push(...r.errors);
  return { actor, roots, results, recipe: { steps: recipe }, errors, summary: summarize(results), stale, joins };
}

/** A class's multiclassing prerequisite (D35): its own primary abilities, or the 2014 PHB table. */
export const primaryOf = cls => prerequisiteFor(cls?.system?.identifier, cls?.system?.primaryAbility);

/** Normalised compendium source of an item (for comparisons). */
export const sourceOf = item => normalizeUuid(item?._stats?.compendiumSource);

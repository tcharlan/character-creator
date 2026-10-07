/**
 * Class spells, Foundry side (PLAN 2.5, from spike 1.7; above level 1 and per class, PLAN 8.2b): counts read
 * from the built character, options from dnd5e's class spell list within the catalog, and creation data. Each
 * class chooses on its own: the first class's selection is `draft.spells`, another class's is
 * `draft.multiclassSpells["multiclass:<identifier>"]`. The pure rules are spells.mjs.
 */

import { makeError } from "../contracts.mjs";
import { normalizeUuid } from "../catalog/filters.mjs";
import { requirements, validateSpells, spellStates, defaultSpells, normalizeSelection } from "./spells.mjs";
import { maxSpellLevelFor } from "./steps.mjs";

const norm = u => normalizeUuid(u);

/**
 * Level-1 spellcasting facts for a class item on the fully built character: level-1 options can change the
 * numbers through Active Effects (spike 1.9: Thaumaturge, Magician), and a scale entry may then be a plain
 * number instead of a ScaleValue object.
 */
export function spellFacts(actor, classItem) {
  const sc = classItem?.system.spellcasting ?? {};
  const identifier = classItem?.identifier ?? null;
  const scale = Object.fromEntries(Object.entries(actor.system.scale?.[identifier] ?? {})
    .map(([k, v]) => [k, (v && typeof v === "object" && "value" in v) ? v.value : v]));
  const spells = actor.system.spells ?? {};
  return {
    identifier, name: classItem?.name ?? null,
    classLevel: classItem?.system.levels ?? 1,
    maxLevel: classItem ? maxSpellLevelFor(classItem, actor) : 0,
    progression: sc.progression ?? null, type: sc.type ?? null, ability: sc.ability ?? null,
    preparation: { formula: sc.preparation?.formula ?? "", max: sc.preparation?.max ?? null },
    scale,
    slots: { spell1: spells.spell1?.max ?? 0, pact: spells.pact?.max ?? 0, pactLevel: spells.pact?.level ?? 0 }
  };
}

/**
 * The class's spell options within the catalog: `list` (Set of allowed UUIDs), `levels` (UUID → level, for
 * every catalog spell so off-list picks still get a level), and `cantrips` / `level1` sorted by name.
 */
export function spellOptions(identifier, catalog) {
  const classList = new Set([...(dnd5e.registry.spellLists.forType("class", identifier)?.uuids ?? [])].map(norm));
  const levels = new Map();
  const onList = [];
  for ( const e of catalog.byCategory.spell ) {
    const uuid = norm(e.uuid);
    levels.set(uuid, e.system?.level);
    if ( classList.has(uuid) ) onList.push(e);
  }
  onList.sort((a, b) => a.name.localeCompare(b.name));
  const at = lvl => onList.filter(e => e.system?.level === lvl).map(e => norm(e.uuid));
  // Every leveled spell on the list, lowest level first, then by name.
  const leveled = onList.filter(e => (e.system?.level ?? 0) >= 1)
    .sort((a, b) => (a.system.level - b.system.level) || a.name.localeCompare(b.name)).map(e => norm(e.uuid));
  return { list: new Set(onList.map(e => norm(e.uuid))), levels, cantrips: at(0), level1: at(1), leveled };
}

/** Spells the character already has from other sources (species, feats…), normalised. */
export function ownedSpells(actor) {
  return new Set(actor.items.filter(i => i.type === "spell").map(i => norm(i._stats?.compendiumSource)).filter(Boolean));
}

/**
 * Everything the spell step and its check need, for one class of a built character.
 * @param {{ actor: Actor, roots: object }} built   From buildCharacter().
 * @param {object} catalog
 * @param {string} [root="class"]   The class: `class`, or `multiclass:<identifier>`.
 * @param {{ exclude?: Set<string> }} [options]   Spells the defaults leave out (those another class already chose).
 * @returns {{ facts, req, options, owned, defaults }}
 */
export function spellContext({ actor, roots }, catalog, root = "class", { exclude = new Set() } = {}) {
  const cls = actor.items.get(roots?.[root]);
  const facts = spellFacts(actor, cls);
  const req = requirements(facts);
  const options = cls ? spellOptions(facts.identifier, catalog)
    : { list: new Set(), levels: new Map(), cantrips: [], level1: [], leveled: [] };
  const owned = ownedSpells(actor);
  return { facts, req, options, owned, defaults: defaultSpells(req, options, new Set([...owned, ...exclude])) };
}

/** The class roots of a built character, the first class first: `class`, then `multiclass:<identifier>`. */
export const classRoots = built => Object.keys(built?.roots ?? {}).filter(r => (r === "class") || r.startsWith("multiclass:"))
  .sort((a, b) => (a === "class" ? -1 : b === "class" ? 1 : 0));

/** A class's spell selection in the draft. */
export const selectionFor = (draft, root) => (root === "class" ? draft.spells : draft.multiclassSpells?.[root])
  ?? { cantrips: [], spells: [], spellbook: [] };

/**
 * Spells another class of the character already takes (a multiclassed caster): the same spell twice would only
 * be a second copy of it, so a spell counts for the first class that picks it and is "already known" to the rest.
 * @returns {Map<string, string>} UUID → the class root that has it
 */
export function takenByOthers(built, draft, root) {
  const taken = new Map();
  for ( const other of classRoots(built) ) {
    if ( other === root ) continue;
    const sel = normalizeSelection(selectionFor(draft, other));
    for ( const uuid of [...sel.cantrips, ...sel.spells, ...sel.spellbook] ) if ( !taken.has(uuid) ) taken.set(uuid, other);
  }
  return taken;
}

/** Check a draft's spells on its built character, class by class. Returns makeError() objects. */
export function checkDraftSpells(built, draft, { catalog }) {
  const errors = [];
  const roots = classRoots(built);
  for ( const [i, root] of roots.entries() ) {
    const { req, options, owned: fromItems } = spellContext(built, catalog, root);
    // What an earlier class already chose counts as known here (the first class to pick a spell keeps it).
    const owned = new Set(fromItems);
    for ( const earlier of roots.slice(0, i) ) {
      const sel = normalizeSelection(selectionFor(draft, earlier));
      for ( const uuid of [...sel.cantrips, ...sel.spells, ...sel.spellbook] ) owned.add(uuid);
    }
    errors.push(...validateSpells(req, selectionFor(draft, root), { list: options.list, levels: options.levels, owned })
      // Another class's problems say which class they are about.
      .map(e => (root === "class" ? e : { ...e, detail: { class: root, detail: e.detail ?? null } })));
  }
  // A selection for a class the character doesn't have.
  for ( const root of Object.keys(draft.multiclassSpells ?? {}) ) {
    if ( !built.roots?.[root] ) errors.push(makeError("NOT_A_CASTER", { class: root }));
  }
  return errors;
}

/**
 * Creation data for the chosen spells, linked to the class the way dnd5e expects (`sourceItem`, `method`,
 * `prepared` — RESEARCH.md → Spike 1.7).
 */
export async function spellCreationData(built, selection, { catalog, root = "class" }) {
  const { facts, req } = spellContext(built, catalog, root);
  const data = [];
  for ( const { uuid, prepared } of spellStates(req, normalizeSelection(selection)) ) {
    const doc = await fromUuid(uuid);
    if ( !doc ) throw new Error(`Missing spell ${uuid}`);
    const d = game.items.fromCompendium(doc);
    d._id = foundry.utils.randomID();
    Object.assign(d.system, { sourceItem: `class:${facts.identifier}`, method: req.method, prepared });
    data.push(d);
  }
  return data;
}

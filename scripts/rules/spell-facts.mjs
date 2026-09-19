/**
 * Level-1 class spells, Foundry side (PLAN 2.5, from spike 1.7): counts read from the built character,
 * options from dnd5e's class spell list within the catalog, and creation data. The pure rules are
 * spells.mjs.
 */

import { normalizeUuid } from "../catalog/filters.mjs";
import { requirements, validateSpells, spellStates, defaultSpells, normalizeSelection } from "./spells.mjs";

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
  return { list: new Set(onList.map(e => norm(e.uuid))), levels, cantrips: at(0), level1: at(1) };
}

/** Spells the character already has from other sources (species, feats…), normalised. */
export function ownedSpells(actor) {
  return new Set(actor.items.filter(i => i.type === "spell").map(i => norm(i._stats?.compendiumSource)).filter(Boolean));
}

/**
 * Everything the spell step and its check need, for a built character.
 * @param {{ actor: Actor, roots: object }} built   From buildCharacter().
 * @param {object} catalog
 * @returns {{ facts, req, options, owned, defaults }}
 */
export function spellContext({ actor, roots }, catalog) {
  const cls = actor.items.get(roots?.class);
  const facts = spellFacts(actor, cls);
  const req = requirements(facts);
  const options = cls ? spellOptions(facts.identifier, catalog) : { list: new Set(), levels: new Map(), cantrips: [], level1: [] };
  const owned = ownedSpells(actor);
  return { facts, req, options, owned, defaults: defaultSpells(req, options, owned) };
}

/** Check a draft's spells on its built character. Returns makeError() objects. */
export function checkDraftSpells(built, draft, { catalog }) {
  const { req, options, owned } = spellContext(built, catalog);
  return validateSpells(req, draft.spells, { list: options.list, levels: options.levels, owned });
}

/**
 * Creation data for the chosen spells, linked to the class the way dnd5e expects (`sourceItem`, `method`,
 * `prepared` — RESEARCH.md → Spike 1.7).
 */
export async function spellCreationData(built, selection, { catalog }) {
  const { facts, req } = spellContext(built, catalog);
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

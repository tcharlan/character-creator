/*
 * SPIKE 1.7 — throwaway. Level-1 spell counts from class data, for every SRD class in both rule sets.
 *
 * Question: can cantrip / prepared / known / spellbook counts be read from dnd5e's class data (scale
 * values, `spellcasting.preparation.formula`), or do we need a per-class table (convention 2 allows one
 * only where dnd5e has no data)? Also: the class spell lists from dnd5e's registry, with levels read
 * from the pack index (not by loading documents — spike 1.4 finding).
 */

import { makeActor, embed, normalizeUuid } from "./lib.mjs";
import { requirements, spellStates } from "./spells-core.mjs";

export const CLASS_PACKS = { legacy: "dnd5e.classes", modern: "dnd5e.classes24" };
export const SPELL_PACKS = { legacy: "dnd5e.spells", modern: "dnd5e.spells24" };

/** Spell level by UUID for the rule set's spell pack, from the index. */
export async function spellLevels(rules) {
  const index = await game.packs.get(SPELL_PACKS[rules]).getIndex({ fields: ["system.level", "system.source.rules"] });
  return new Map(index.map(e => [normalizeUuid(e.uuid), e.system?.level]));
}

/** Level-1 spellcasting facts for one class, read from a scratch actor. */
export async function classSpellFacts(classDoc, { score = 14, levels } = {}) {
  const actor = makeActor({ str: score, dex: score, con: score, int: score, wis: score, cha: score });
  const cls = embed(actor, classDoc, { "system.levels": 1 });
  actor.updateSource({ "system.details.originalClass": cls.id });
  actor.reset();
  return factsFromActor(actor, actor.items.get(cls.id), levels);
}

/**
 * Level-1 spellcasting facts for a class item on any actor. Use the fully built character: level-1
 * options can change the numbers through Active Effects (spike 1.9: Thaumaturge, Magician), and a
 * scale entry may then be a plain number instead of a ScaleValue object.
 */
export function factsFromActor(actor, item, levels) {
  const cls = item;
  const sc = item.system.spellcasting ?? {};
  const id = item.identifier;
  const scale = Object.fromEntries(Object.entries(actor.system.scale?.[id] ?? {})
    .map(([k, v]) => [k, (v && typeof v === "object" && "value" in v) ? v.value : v]));
  const spells = actor.system.spells ?? {};

  const facts = {
    name: item.name, identifier: id,
    progression: sc.progression, type: sc.type ?? null, ability: sc.ability ?? null,
    preparation: { formula: sc.preparation?.formula ?? "", max: sc.preparation?.max ?? null },
    scale,
    slots: { spell1: spells.spell1?.max ?? 0, pact: spells.pact?.max ?? 0, pactLevel: spells.pact?.level ?? 0 },
    level1Advancements: (item.advancement.byLevel?.[1] ?? []).map(a => `${a.type}:${a.title}`),
    list: null
  };

  // Class spell list from dnd5e's registry, split by level using the pack index.
  const list = dnd5e.registry.spellLists.forType("class", id);
  if ( list && levels ) {
    const uuids = [...list.uuids].map(normalizeUuid);
    const byLevel = lvl => uuids.filter(u => levels.get(u) === lvl).length;
    facts.list = { total: uuids.length, level0: byLevel(0), level1: byLevel(1),
      outsidePack: uuids.filter(u => !levels.has(u)).length };
  }
  // Not serialised in reports: the live scratch actor, its class item and the class list.
  Object.defineProperty(facts, "live", { value: { actor, classId: cls.id, listUuids: new Set(
    list ? [...list.uuids].map(normalizeUuid) : []) } });
  return facts;
}

/**
 * Embed chosen spells on the facts' scratch actor the way the GM would create them (sourceItem,
 * method, prepared), then read dnd5e's own prepared count for the class.
 * @returns {{ preparedValue, preparedMax, embedded }}
 */
export async function embedSpells(facts, selection) {
  const { actor, classId } = facts.live;
  const req = requirements(facts);
  const data = [];
  for ( const { uuid, prepared } of spellStates(req, selection) ) {
    const doc = await fromUuid(uuid);
    const d = game.items.fromCompendium(doc);
    d._id = foundry.utils.randomID();
    Object.assign(d.system, { sourceItem: `class:${facts.identifier}`, method: req.method, prepared });
    data.push(d);
  }
  actor.updateSource({ items: data });
  actor.reset();
  const cls = actor.items.get(classId);
  return {
    preparedValue: cls.system.spellcasting.preparation.value,
    preparedMax: cls.system.spellcasting.preparation.max,
    embedded: data.length,
    classIdentifiers: [...new Set(actor.items.filter(i => i.type === "spell").map(i => i.system.classIdentifier))]
  };
}

/** Survey every class of the rule set. */
export async function survey(rules, options = {}) {
  const pack = game.packs.get(CLASS_PACKS[rules]);
  const index = await pack.getIndex({ fields: ["type"] });
  const levels = await spellLevels(rules);
  const rows = [];
  for ( const e of index.filter(x => x.type === "class") ) {
    rows.push(await classSpellFacts(await pack.getDocument(e._id), { ...options, levels }));
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

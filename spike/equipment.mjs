/*
 * SPIKE 1.6 — throwaway. Foundry side of starting equipment: category candidates from the compendium
 * index, proficiency via dnd5e, and creation data via dnd5e's Item5e.createWithContents (containers).
 * The pure resolver is spike/equipment-core.mjs.
 */

import { buildTree, CATEGORIES, KNOWN_TYPES, defaultSelection, resolveSelection, wealthOption } from "./equipment-core.mjs";
import { makeActor, normalizeUuid } from "./lib.mjs";

/** Equipment packs per rule set (the real module takes these from the catalog). */
export const EQUIPMENT_PACKS = { legacy: ["dnd5e.items"], modern: ["dnd5e.equipment24"] };
export const SOURCE_PACKS = {
  legacy: ["dnd5e.classes", "dnd5e.backgrounds"],
  modern: ["dnd5e.classes24", "dnd5e.origins24"]
};

const INDEX_FIELDS = ["type", "system.type.value", "system.type.baseItem", "system.properties", "system.rarity",
  "system.source.rules", "system.quantity"];

/** Non-magical physical items of the rule set, from the pack index (no documents loaded). */
export async function equipmentIndex(rules) {
  const out = [];
  for ( const id of EQUIPMENT_PACKS[rules] ) {
    const index = await game.packs.get(id).getIndex({ fields: INDEX_FIELDS });
    for ( const e of index ) {
      const props = e.system?.properties ?? [];
      const magical = !!e.system?.rarity || (Array.isArray(props) ? props.includes("mgc") : props?.mgc);
      if ( !magical ) out.push(e);
    }
  }
  return out;
}

/**
 * dnd5e's canonical base items per category (swapped per rules version by dnd5e itself):
 * base item id → compendium UUID.
 */
export function canonicalIds(type) {
  const C = CONFIG.DND5E;
  if ( type === "weapon" ) return C.weaponIds ?? {};
  if ( type === "armor" ) return { ...(C.armorIds ?? {}), ...(C.shieldIds ?? {}) };
  if ( type === "tool" ) return C.toolIds ?? {};
  return {};
}

/**
 * Does an index entry belong to a category entry (`weapon`/`armor`/`tool`/`focus` + key)?
 * Weapons and armor must be one of dnd5e's canonical base items (excludes e.g. "Unarmed Strike").
 */
export function matchesCategory(node, e) {
  const C = CONFIG.DND5E;
  const value = e.system?.type?.value;
  // A base item: its baseItem is canonical, or it IS the canonical item (the 2014 SRD Flute lacks baseItem).
  const isBase = () => {
    const ids = canonicalIds(node.type);
    return ((e.system?.type?.baseItem ?? "") in ids) || Object.values(ids).map(normalizeUuid).includes(normalizeUuid(e.uuid));
  };
  switch ( node.type ) {
    case "weapon":
      if ( e.type !== "weapon" || !isBase() ) return false;
      return node.key in C.weaponProficiencies ? C.weaponProficienciesMap[value] === node.key : value === node.key;
    case "armor":
      return e.type === "equipment" && value === node.key && isBase();
    case "tool":
      // Not limited to dnd5e's toolIds: its config lacks some 2024 tools (a 2024 gaming set).
      return e.type === "tool" && value === node.key;
    case "focus": {
      const ids = C.focusTypes[node.key]?.itemIds ?? {};
      return (e.system?.type?.baseItem in ids) || Object.values(ids).map(normalizeUuid).includes(normalizeUuid(e.uuid));
    }
  }
  return false;
}

/**
 * Candidate UUIDs for a category entry, sorted by name: one per base item, preferring dnd5e's
 * canonical item (so a focus "Staff" doesn't duplicate the Quarterstaff).
 */
export function candidatesFor(node, index) {
  // Key by the item's own canonical id when it is a canonical item (the 2014 SRD Pan Flute has
  // baseItem "flute"), otherwise by its baseItem.
  const keyOf = Object.fromEntries(Object.entries(canonicalIds(node.type)).map(([k, u]) => [normalizeUuid(u), k]));
  const canonical = new Set(Object.keys(keyOf));
  const byBase = new Map();
  for ( const e of index.filter(x => matchesCategory(node, x)) ) {
    const base = keyOf[normalizeUuid(e.uuid)] ?? (e.system?.type?.baseItem || e.uuid);
    const prev = byBase.get(base);
    if ( !prev || (!canonical.has(normalizeUuid(prev.uuid)) && canonical.has(normalizeUuid(e.uuid))) ) byBase.set(base, e);
  }
  return [...byBase.values()].sort((a, b) => a.name.localeCompare(b.name)).map(e => e.uuid);
}

/**
 * Proficiency checker backed by dnd5e: each item is embedded in a copy of the character and its
 * `system.proficiencyMultiplier` is read.
 */
export async function proficiencyChecker(actor, uuids) {
  // From a toObject() copy, so it shares no arrays with schema defaults (spike 1.2).
  const copy = new Actor.implementation({ ...actor.toObject(), items: actor.items.filter(i => !i.system?.quantity)
    .map(i => i.toObject()) });
  const ids = {};
  for ( const uuid of new Set(uuids) ) {
    const doc = await fromUuid(uuid);
    if ( !doc ) continue;
    const data = game.items.fromCompendium(doc);
    data._id = foundry.utils.randomID();
    copy.updateSource({ items: [data] });
    ids[uuid] = data._id;
  }
  copy.reset();
  const result = {};
  for ( const [uuid, id] of Object.entries(ids) ) result[uuid] = (copy.items.get(id)?.system.proficiencyMultiplier ?? 0) >= 1;
  return uuid => result[uuid] ?? false;
}

/** Creation data for resolved items: containers bring their contents (dnd5e). Quantity = count. */
export async function creationData(items) {
  const data = [];
  for ( const { uuid, count } of items ) {
    const doc = await fromUuid(uuid);
    if ( !doc ) throw new Error(`Missing item ${uuid}`);
    const created = await Item.implementation.createWithContents([doc]);
    if ( count > 1 ) created[0].system.quantity = count;
    data.push(...created);
  }
  return data;
}

/**
 * Inventory + default resolution for every class and background of a rule set.
 * @param {string} rules
 * @param {Actor} actor   A built character (for "if proficient" entries).
 */
export async function survey(rules, actor) {
  const index = await equipmentIndex(rules);
  const byUuid = new Map(index.map(e => [normalizeUuid(e.uuid), e]));
  const rows = [];
  for ( const packId of SOURCE_PACKS[rules] ) {
    const pack = game.packs.get(packId);
    const entries = (await pack.getIndex({ fields: ["type"] })).filter(e => ["class", "background"].includes(e.type));
    for ( const entry of entries ) {
      const doc = await pack.getDocument(entry._id);
      const raw = doc.system.toObject().startingEquipment;
      const tree = buildTree(raw);
      const nodes = [...tree.nodes.values()];
      const row = { name: doc.name, type: doc.type, uuid: doc.uuid, wealth: doc.system.wealth ?? null, problems: [] };

      row.unknownTypes = nodes.filter(n => !KNOWN_TYPES.includes(n.type)).map(n => n.type);
      const linked = nodes.filter(n => n.type === "linked");
      row.missingLinked = [];
      for ( const n of linked ) if ( !(await fromUuid(n.key)) ) row.missingLinked.push(n.key);
      row.linkedNotInEquipmentIndex = linked.filter(n => !byUuid.has(normalizeUuid(n.key))).map(n => n.key);
      row.categories = nodes.filter(n => CATEGORIES.includes(n.type)).map(n => ({
        id: n._id, type: n.type, key: n.key, count: n.count ?? 1, candidates: candidatesFor(n, index).length
      }));
      row.requiresProficiency = linked.filter(n => n.requiresProficiency).map(n => n.key);
      const isProficient = await proficiencyChecker(actor, linked.map(n => n.key));

      const selection = defaultSelection(tree, { candidates: n => candidatesFor(n, index), isProficient });
      const inCategory = (n, u) => candidatesFor(n, index).map(normalizeUuid).includes(normalizeUuid(u));
      const result = resolveSelection(tree, row.wealth, selection, { inCategory, isProficient });
      row.errors = result.errors;
      row.items = result.items.length;
      row.currency = result.currency;
      try {
        const data = await creationData(result.items);
        row.createdDocs = data.length;
        row.containers = data.filter(d => d.type === "container").map(d => d.name);
        // Proof the data embeds: add it to a scratch actor.
        const scratch = makeActor();
        scratch.updateSource({ items: data });
        row.embedded = scratch.items.size;
      } catch ( err ) {
        row.problems.push(`creation: ${err.message}`);
      }

      const option = wealthOption(row.wealth);
      row.wealthOption = option;
      if ( option?.formula ) {
        const lo = (await new Roll(option.formula).evaluate({ minimize: true })).total;
        const hi = (await new Roll(option.formula).evaluate({ maximize: true })).total;
        row.wealthRollRange = [lo, hi];
      }
      row.selection = selection;
      row.tree = tree;
      rows.push(row);
    }
  }
  return { index, rows };
}

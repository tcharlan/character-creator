/**
 * Starting equipment, Foundry side (PLAN 2.5, from spike 1.6): category candidates from the catalog,
 * proficiency via dnd5e, the 2014 rolled wealth (D15), and creation data via dnd5e's
 * `Item5e.createWithContents` (containers bring their contents). The pure resolver is equipment.mjs.
 */

import { makeError } from "../contracts.mjs";
import { normalizeUuid } from "../catalog/filters.mjs";
import { buildTree, resolveSelection, defaultSelection, listDecisions, wealthOption, addCurrency, EQUIPMENT_SOURCES }
  from "./equipment.mjs";
import { ROLL_PURPOSE, checkRecord } from "./roll-record.mjs";
import { postRolls, readRollRecord, rollMessagesFor } from "./roll-messages.mjs";

const norm = u => normalizeUuid(u);

/** A magic item: has a rarity or the "mgc" property (index data). */
function isMagical(e) {
  const props = e.system?.properties ?? [];
  return !!e.system?.rarity || (Array.isArray(props) ? props.includes("mgc") : !!props?.mgc);
}

/** dnd5e's canonical base items per category (swapped per rules version by dnd5e): base item id → UUID. */
export function canonicalIds(type) {
  const C = CONFIG.DND5E;
  if ( type === "weapon" ) return C.weaponIds ?? {};
  if ( type === "armor" ) return { ...(C.armorIds ?? {}), ...(C.shieldIds ?? {}) };
  if ( type === "tool" ) return C.toolIds ?? {};
  return {};
}

/**
 * Does a catalog entry belong to a category entry (`weapon`/`armor`/`tool`/`focus` + key)? Weapons and armor
 * must be one of dnd5e's canonical base items (excludes e.g. "Unarmed Strike"; RESEARCH.md → Spike 1.6).
 */
export function matchesCategory(node, e) {
  const C = CONFIG.DND5E;
  const value = e.system?.type?.value;
  // A base item: its baseItem is canonical, or it IS the canonical item (the 2014 SRD Flute lacks baseItem).
  const isBase = () => {
    const ids = canonicalIds(node.type);
    return ((e.system?.type?.baseItem ?? "") in ids) || Object.values(ids).map(norm).includes(norm(e.uuid));
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
      return (e.system?.type?.baseItem in ids) || Object.values(ids).map(norm).includes(norm(e.uuid));
    }
  }
  return false;
}

const candidateCache = new WeakMap();

/**
 * Candidate UUIDs (normalised) for a category entry, from the catalog's non-magical equipment, sorted by
 * name: one per base item, preferring dnd5e's canonical item (a focus "Staff" doesn't duplicate the
 * Quarterstaff). Cached per catalog.
 */
export function candidatesFor(node, catalog) {
  let cache = candidateCache.get(catalog);
  if ( !cache ) candidateCache.set(catalog, cache = new Map());
  const key = `${node.type}:${node.key}`;
  if ( cache.has(key) ) return cache.get(key);
  // Key by the item's own canonical id when it is a canonical item (the 2014 SRD Pan Flute has
  // baseItem "flute"), otherwise by its baseItem.
  const keyOf = Object.fromEntries(Object.entries(canonicalIds(node.type)).map(([k, u]) => [norm(u), k]));
  const byBase = new Map();
  for ( const e of catalog.byCategory.equipment ) {
    if ( isMagical(e) || !matchesCategory(node, e) ) continue;
    const uuid = norm(e.uuid);
    const base = keyOf[uuid] ?? (e.system?.type?.baseItem || uuid);
    const prev = byBase.get(base);
    if ( !prev || (!(norm(prev.uuid) in keyOf) && (uuid in keyOf)) ) byBase.set(base, e);
  }
  const out = [...byBase.values()].sort((a, b) => a.name.localeCompare(b.name)).map(e => norm(e.uuid));
  cache.set(key, out);
  return out;
}

/**
 * Proficiency checker backed by dnd5e: each item is embedded in a copy of the character and its
 * `system.proficiencyMultiplier` is read.
 * @returns {Promise<(uuid: string) => boolean>}
 */
export async function proficiencyChecker(actor, uuids) {
  // From a toObject() copy, so it shares no arrays with schema defaults (spike 1.2).
  const copy = new Actor.implementation({ ...actor.toObject(), items: actor.items.filter(i => !i.system?.quantity)
    .map(i => i.toObject()) });
  const ids = {};
  for ( const uuid of new Set(uuids.map(norm)) ) {
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
  return uuid => result[norm(uuid)] ?? false;
}

/**
 * Everything to show or check one source item's starting equipment on a built character.
 * @param {Actor} actor       The built (scratch) character.
 * @param {Item} item         Its class or background item.
 * @param {object} catalog
 */
export async function equipmentContext(actor, item, catalog) {
  const tree = buildTree(item?.system.toObject().startingEquipment ?? []);
  const linked = [...tree.nodes.values()].filter(n => n.type === "linked").map(n => n.key);
  const isProficient = await proficiencyChecker(actor, linked);
  const candidates = node => candidatesFor(node, catalog);
  return {
    tree,
    wealth: item?.system.wealth ?? null,
    wealthOption: wealthOption(item?.system.wealth),
    candidates,
    isProficient,
    isAllowed: uuid => catalog.isAllowed(uuid),
    inCategory: (node, uuid) => candidates(node).includes(norm(uuid))
  };
}

/**
 * What the wizard shows for one source: decisions reachable from the choices so far (with category
 * candidates), linked entries with proficiency, the wealth option, and a default selection (D4 model).
 */
export async function equipmentOptions(actor, item, catalog, choices = {}) {
  const ctx = await equipmentContext(actor, item, catalog);
  const decisions = listDecisions(ctx.tree, choices).map(d => (d.kind === "category" ? { ...d, candidates: ctx.candidates(d) } : d));
  const linked = [...ctx.tree.nodes.values()].filter(n => n.type === "linked")
    .map(n => ({ id: n._id, uuid: norm(n.key), requiresProficiency: !!n.requiresProficiency, proficient: ctx.isProficient(n.key),
      allowed: ctx.isAllowed(n.key) }));
  return { tree: ctx.tree, decisions, linked, wealth: ctx.wealthOption,
    defaultSelection: defaultSelection(ctx.tree, { candidates: ctx.candidates, isProficient: ctx.isProficient, isAllowed: ctx.isAllowed }) };
}

/** The dice formula to roll for a wealth option (rebuilt from its parts, so it always parses). */
export const wealthFormula = o => `${o.number}d${o.faces}${o.multiplier > 1 ? ` * ${o.multiplier}` : ""}`;

/**
 * Roll 2014 starting wealth in the player's browser and post it to chat (D15). Refuses when the draft
 * already holds a roll for this source (re-rolling means discarding the draft, A10).
 * @param {object} draft
 * @param {"class"|"background"} source
 * @param {string} wealth      The source item's `system.wealth`.
 * @returns {Promise<{ total: number, messageId: string }>}  Store as `draft.equipment[source].wealth`.
 */
export async function rollStartingWealth(draft, source, wealth) {
  const option = wealthOption(wealth);
  if ( !option?.number ) throw Object.assign(new Error("No wealth roll"), makeError("NO_WEALTH_OPTION", { source }));
  if ( draft.equipment?.[source]?.wealth?.messageId ) {
    throw Object.assign(new Error("Already rolled"), makeError("WEALTH_ROLL_INVALID", { source, alreadyRolled: true }));
  }
  const formula = wealthFormula(option);
  const { messageId, results } = await postRolls({ draftId: draft.id, purpose: ROLL_PURPOSE.WEALTH, source, formula,
    flavor: game.i18n.format("CHARCREATOR.WealthRoll.Flavor", { formula }) });
  return { total: results[0], messageId };
}

/**
 * GM check of a source's wealth roll against the chat record. Also rejects rolling and then taking the
 * items instead (A10), even with the roll removed from the draft.
 */
export function checkWealthRoll(draft, source, selection, wealth, { userId }) {
  const option = wealthOption(wealth);
  const onRecord = rollMessagesFor(draft.id, userId, ROLL_PURPOSE.WEALTH, source);
  const rolledMode = selection?.mode === "wealth" && option?.number;
  if ( !rolledMode ) {
    return onRecord.length ? [makeError("WEALTH_ROLL_INVALID", { source, rolledButMode: selection?.mode ?? null, messages: onRecord })] : [];
  }
  const messageId = selection.wealth?.messageId;
  const record = readRollRecord(messageId ? game.messages.get(messageId) : null);
  return checkRecord(record, { code: "WEALTH_ROLL_INVALID", draftId: draft.id, userId, purpose: ROLL_PURPOSE.WEALTH, source,
    spec: { number: option.number, faces: option.faces, multiplier: option.multiplier }, count: 1,
    results: [selection.wealth?.total], others: onRecord.filter(id => id !== messageId) })
    .map(e => ({ ...e, detail: { source, ...e.detail } }));
}

/**
 * Resolve and check both sources' equipment for a built character (D23: independent choices).
 * @param {{ actor: Actor, roots: object }} built   From buildCharacter().
 * @param {object} draft
 * @param {object} options
 * @param {object} options.catalog
 * @param {string} [options.userId]   The draft's owner; when given, rolled wealth is checked against chat (GM).
 * @returns {Promise<{ items: {uuid, count, source}[], currency: object, errors: object[] }>}
 */
export async function resolveDraftEquipment({ actor, roots }, draft, { catalog, userId }) {
  const items = [];
  const currency = {};
  const errors = [];
  for ( const source of EQUIPMENT_SOURCES ) {
    const item = actor.items.get(roots?.[source]);
    if ( !item ) continue;   // missing picks are reported by buildCharacter
    const selection = draft.equipment?.[source] ?? {};
    const ctx = await equipmentContext(actor, item, catalog);
    const res = resolveSelection(ctx.tree, ctx.wealth, selection, ctx);
    errors.push(...res.errors.map(e => ({ ...e, detail: { source, ...e.detail } })));
    if ( userId ) errors.push(...checkWealthRoll(draft, source, selection, ctx.wealth, { userId }));
    items.push(...res.items.map(i => ({ ...i, source })));
    addCurrency(currency, res.currency);
  }
  return { items, currency, errors };
}

/** Creation data for resolved items: containers bring their contents (dnd5e). Quantity = count. */
export async function equipmentCreationData(items) {
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

/**
 * Catalog filters (DESIGN.md → Allowed content). Pure: no Foundry globals, unit-tested with synthetic
 * data. The Foundry side (scripts/catalog/catalog.mjs) feeds it pack descriptors and index entries.
 *
 * An entry is offered only if all hold:
 *  1. it's in an Item pack;  2. the pack is visible to the user;
 *  3. dnd5e's source filter doesn't disable the pack;  4. the GM's optional pack allowlist includes it;
 *  5. it belongs to a category we offer;  6. its rules version matches the world (entries without one
 *     follow the world);  7. the GM's allowlist for its category (if any) includes it.
 * Exception ("granted by reference", DESIGN.md rule 6): items an allowed entry grants (ItemGrant) or
 * links in its starting equipment are allowed whatever their pack, rules or category. Choice pools
 * (ItemChoice) are not an exception: what a player *picks* always passes the filters.
 */

/** Categories the wizard offers. */
export const CATEGORIES = Object.freeze(["species", "background", "class", "subclass", "feat", "spell", "equipment"]);

/** dnd5e item types that are equipment (physical items). */
const EQUIPMENT_TYPES = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container"]);

/** Category of an index entry by its item type; null for types the wizard doesn't offer. */
export function categoryOf(entry) {
  switch ( entry?.type ) {
    case "race": return "species";
    case "background": return "background";
    case "class": return "class";
    case "subclass": return "subclass";
    // Monster features are feat items too (dnd5e.monsterfeatures*); players never get them.
    case "feat": return entry.system?.type?.value === "monster" ? null : "feat";
    case "spell": return "spell";
    default: return EQUIPMENT_TYPES.has(entry?.type) ? "equipment" : null;
  }
}

/** The `system.source.rules` value matching a world's dnd5e `rulesVersion`. */
export const RULES_EDITION = Object.freeze({ legacy: "2014", modern: "2024" });

/** Does an entry match the world's rules? Entries without `system.source.rules` follow the world (D11). */
export function matchesRules(entry, rules) {
  const edition = entry?.system?.source?.rules;
  return !edition || edition === RULES_EDITION[rules];
}

/**
 * GM restrictions (settings registered in PLAN 2.10; edited in Phase 4). `null` means "no restriction".
 * @typedef {{ packs: string[]|null, categories: Record<string, string[]|null> }} Restrictions
 */
export const NO_RESTRICTIONS = Object.freeze({ packs: null, categories: {} });

/** Canonical compendium UUID (`Compendium.<pkg>.<pack>.Item.<id>`; 2014 data may omit `Item.`). */
export function normalizeUuid(uuid) {
  if ( typeof uuid !== "string" ) return uuid;
  const m = uuid.match(/^Compendium\.([^.]+)\.([^.]+)\.(?:Item\.)?([A-Za-z0-9]{16})$/);
  return m ? `Compendium.${m[1]}.${m[2]}.Item.${m[3]}` : uuid;
}

/**
 * Why a pack is excluded (or null if its entries may be offered).
 * @param {{ collection: string, documentName: string, visible: boolean, sourceEnabled: boolean }} pack
 * @param {Restrictions} restrictions
 */
export function packExclusion(pack, restrictions = NO_RESTRICTIONS) {
  if ( pack.documentName !== "Item" ) return "notItemPack";
  if ( !pack.visible ) return "hidden";
  if ( !pack.sourceEnabled ) return "sourceDisabled";
  if ( restrictions.packs && !restrictions.packs.includes(pack.collection) ) return "packNotAllowed";
  return null;
}

/**
 * Why an entry is excluded (or null if allowed). Pack checks come first (see packExclusion).
 * @param {object} entry          Index entry: `{ uuid, type, system: { source: { rules } } }`.
 * @param {string} rules          "legacy" | "modern".
 * @param {Restrictions} restrictions
 */
export function entryExclusion(entry, rules, restrictions = NO_RESTRICTIONS) {
  const category = categoryOf(entry);
  if ( !category ) return "noCategory";
  if ( !matchesRules(entry, rules) ) return "wrongRules";
  const allow = restrictions.categories?.[category];
  if ( allow && !allow.map(normalizeUuid).includes(normalizeUuid(entry.uuid)) ) return "notInAllowlist";
  return null;
}

/**
 * UUIDs an entry references as fixed content: ItemGrant items and starting-equipment linked items
 * (read from the index fields `system.advancement` and `system.startingEquipment`).
 */
export function fixedReferences(entry) {
  const out = [];
  for ( const adv of Object.values(entry?.system?.advancement ?? {}) ) {
    if ( adv?.type === "ItemGrant" ) for ( const i of adv.configuration?.items ?? [] ) if ( i?.uuid ) out.push(i.uuid);
  }
  for ( const e of entry?.system?.startingEquipment ?? [] ) if ( e?.type === "linked" && e.key ) out.push(e.key);
  return out.map(normalizeUuid);
}

/**
 * Filter packs and entries into the catalog.
 * @param {object} input
 * @param {object[]} input.packs      Pack descriptors (see packExclusion).
 * @param {object[]} input.entries    Index entries, each with `pack` (collection) and `uuid`.
 * @param {string} input.rules
 * @param {Restrictions} [input.restrictions]
 * @param {(uuid: string) => object|undefined} [input.lookup]  Index entry for a UUID in any pack (for
 *   following references of referenced items, e.g. a granted feat's own grants).
 * @returns {{ allowed: Map<string, object>, byCategory: Record<string, object[]>, referenced: Set<string>,
 *   excluded: Record<string, number> }}
 */
export function buildCatalogData({ packs, entries, rules, restrictions = NO_RESTRICTIONS, lookup }) {
  const packStatus = new Map(packs.map(p => [p.collection, packExclusion(p, restrictions)]));
  const allowed = new Map();
  const byCategory = Object.fromEntries(CATEGORIES.map(c => [c, []]));
  const excluded = {};
  const count = reason => excluded[reason] = (excluded[reason] ?? 0) + 1;

  for ( const entry of entries ) {
    // null = the pack passes; a pack we have no descriptor for is excluded.
    const reason = packStatus.has(entry.pack) ? packStatus.get(entry.pack) : "unknownPack";
    const why = reason ?? entryExclusion(entry, rules, restrictions);
    if ( why ) {
      count(why);
      continue;
    }
    const uuid = normalizeUuid(entry.uuid);
    allowed.set(uuid, entry);
    byCategory[categoryOf(entry)].push(entry);
  }

  // Fixed references of allowed entries, followed transitively through entries we can look up.
  const referenced = new Set();
  const queue = [...allowed.values()].flatMap(fixedReferences);
  while ( queue.length ) {
    const uuid = queue.pop();
    if ( referenced.has(uuid) || allowed.has(uuid) ) continue;
    referenced.add(uuid);
    const e = lookup?.(uuid);
    if ( e ) queue.push(...fixedReferences(e));
  }
  for ( const list of Object.values(byCategory) ) list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { allowed, byCategory, referenced, excluded };
}

/**
 * Is a UUID usable in a character: offered by the catalog, or fixed content of something allowed?
 * @param {{ allowed: Map, referenced: Set }} data
 */
export function isAllowed(data, uuid) {
  const u = normalizeUuid(uuid);
  return data.allowed.has(u) || data.referenced.has(u);
}

/**
 * The options of a choice that the catalog still offers, and whether enough remain.
 * For the wizard ("ask your GM") and the Phase 4 settings warning (DESIGN.md → Settings).
 * @param {string[]} options   UUIDs the content offers.
 * @param {number} needed      Picks required.
 * @param {{ allowed: Map }} data
 * @returns {{ available: string[], needed: number, short: boolean, exact: boolean }}
 */
export function shortfall(options, needed, data) {
  const available = options.map(normalizeUuid).filter(u => data.allowed.has(u));
  return { available, needed, short: available.length < needed, exact: available.length === needed };
}

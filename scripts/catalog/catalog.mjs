/**
 * The catalog (DESIGN.md → Allowed content): what a user may choose from in this world, built from
 * compendium indexes only (no documents loaded), identical for the player's wizard and the GM's
 * validator. The filter rules live in ./filters.mjs.
 */

import { MODULE_ID } from "../contracts.mjs";
import { buildCatalogData, isAllowed, shortfall, normalizeUuid, NO_RESTRICTIONS } from "./filters.mjs";

/**
 * Index fields the wizard, the rules adapter and the validator read (confirmed in Phase 1):
 * categories and rules, class links, equipment categories, spell levels, magic, grants and kits.
 */
export const INDEX_FIELDS = Object.freeze(["type", "img", "system.identifier", "system.source", "system.classIdentifier",
  "system.type.value", "system.type.subtype", "system.type.baseItem", "system.level", "system.properties",
  "system.rarity", "system.advancement", "system.startingEquipment"]);

/** World settings whose change invalidates the catalog. */
const WATCHED_SETTINGS = ["core.compendiumConfiguration", "dnd5e.packSourceConfiguration", "dnd5e.rulesVersion"];

/** Pack descriptor for the filters: type, visibility for the current user, dnd5e source filter. */
function describePack(pack, sourceConfig) {
  return { collection: pack.collection, documentName: pack.documentName, visible: pack.visible,
    sourceEnabled: sourceConfig?.[pack.collection] !== false };
}

/**
 * Build the catalog now (use getCatalog() for the cached one).
 * @param {object} [options]
 * @param {string} [options.rules]                 dnd5e rulesVersion; defaults to the world's.
 * @param {import("./filters.mjs").Restrictions} [options.restrictions]  GM restrictions (settings: PLAN 2.10).
 */
export async function buildCatalog({ rules = game.settings.get("dnd5e", "rulesVersion"), restrictions = NO_RESTRICTIONS } = {}) {
  const t0 = performance.now();
  const sourceConfig = game.settings.get("dnd5e", "packSourceConfiguration") ?? {};
  const packs = game.packs.contents.map(p => describePack(p, sourceConfig));
  const packStatus = new Map(packs.map(p => [p.collection, p]));
  // Only read the index of packs that can contribute (Item packs the user can see and dnd5e enables).
  const entries = [];
  const all = new Map();
  for ( const pack of game.packs.contents ) {
    const d = packStatus.get(pack.collection);
    if ( d.documentName !== "Item" || !d.visible || !d.sourceEnabled ) continue;
    const index = await pack.getIndex({ fields: INDEX_FIELDS });
    for ( const e of index ) {
      const entry = { ...e, pack: pack.collection, uuid: e.uuid ?? `Compendium.${pack.collection}.Item.${e._id}` };
      entries.push(entry);
      all.set(normalizeUuid(entry.uuid), entry);
    }
  }
  const data = buildCatalogData({ packs, entries, rules, restrictions, lookup: uuid => all.get(normalizeUuid(uuid)) });
  return Object.freeze({
    rules, restrictions,
    ...data,
    /** Index entry of an allowed UUID (either UUID form). */
    get: uuid => data.allowed.get(normalizeUuid(uuid)),
    /** Offered, or fixed content (grant / kit) of something offered. */
    isAllowed: uuid => isAllowed(data, uuid),
    /** Options of a choice the catalog offers, and whether enough remain. */
    shortfall: (options, needed) => shortfall(options, needed, data),
    stats: { packsRead: new Set(entries.map(e => e.pack)).size, entries: entries.length, allowed: data.allowed.size,
      referenced: data.referenced.size, ms: Math.round(performance.now() - t0) }
  });
}

/* -------------------------------------------- */
/*  Cache                                       */
/* -------------------------------------------- */

const cache = new Map();
let generation = 0;

/** The cached catalog for these options (built on first use, rebuilt after invalidation). */
export function getCatalog(options = {}) {
  const rules = options.rules ?? game.settings.get("dnd5e", "rulesVersion");
  const restrictions = options.restrictions ?? NO_RESTRICTIONS;
  const key = JSON.stringify([rules, restrictions, game.user?.id, game.user?.role]);
  if ( !cache.has(key) ) {
    const promise = buildCatalog({ rules, restrictions });
    promise.catch(() => cache.delete(key));
    cache.set(key, promise);
  }
  return cache.get(key);
}

/** Drop every cached catalog (the next getCatalog() rebuilds). */
export function invalidateCatalog(reason = "manual") {
  cache.clear();
  generation++;
  Hooks.callAll(`${MODULE_ID}.catalogInvalidated`, { reason, generation });
}

/** How many times the cache has been invalidated (for tests). */
export const catalogGeneration = () => generation;

/**
 * Invalidate on anything that changes the catalog: pack visibility (core.compendiumConfiguration),
 * dnd5e's source filter and rules version, this module's settings, the user's role, and item changes
 * inside compendiums.
 */
export function registerCatalogHooks() {
  const onSetting = setting => {
    const key = setting?.key ?? "";
    if ( WATCHED_SETTINGS.includes(key) || key.startsWith(`${MODULE_ID}.`) ) invalidateCatalog(`setting ${key}`);
  };
  Hooks.on("createSetting", onSetting);
  Hooks.on("updateSetting", onSetting);
  Hooks.on("updateUser", (user, changes) => {
    if ( user.isSelf && ("role" in changes) ) invalidateCatalog("role");
  });
  for ( const op of ["create", "update", "delete"] ) {
    Hooks.on(`${op}Item`, item => {
      if ( item.pack ) invalidateCatalog(`${op} ${item.pack}`);
    });
  }
}

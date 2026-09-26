/**
 * What to call an item. The catalog holds the names of everything a player may choose; an item from a pack the
 * GM has narrowed away (or from a book the catalog doesn't cover) still has a name in its compendium's index,
 * and a raw UUID on screen helps nobody.
 *
 * No imports: this is used by the pure step models as well as by the catalog itself.
 */

/**
 * @param {string} uuid
 * @param {{ get?: (uuid: string) => { name?: string }|undefined }} [catalog]
 * @returns {string}
 */
export function itemName(uuid, catalog = null) {
  const known = catalog?.get?.(uuid)?.name;
  if ( known ) return known;
  const parts = String(uuid ?? "").split(".");
  // Compendium.<package>.<pack>.Item.<id>, or the 2014 form without "Item".
  if ( (parts[0] !== "Compendium") || (parts.length < 4) ) return String(uuid ?? "");
  const id = parts.at(-1);
  const pack = globalThis.game?.packs?.get(`${parts[1]}.${parts[2]}`);
  return pack?.index?.get(id)?.name ?? id;
}

/**
 * Recipe step addressing (spike 1.9). Pure: no Foundry globals.
 *
 * An item on the scratch actor is addressed by a path: the picked item's role, then one
 * "<advancementId>:<compendium UUID>" segment per grant from there (a subclass hangs off its class's
 * Subclass advancement). Two copies of the same item (Magic Initiate from Versatile and from Sage)
 * get different paths, so a recipe replays unambiguously.
 */

import { ROLES, isId, isCompendiumUuid } from "../contracts.mjs";
import { normalizeUuid } from "../catalog/filters.mjs";

/** "<advancementId>:<uuid>" (UUID normalised). */
export function formatSegment(advancementId, uuid) {
  return `${advancementId}:${normalizeUuid(uuid)}`;
}

/** Parse a segment; null if malformed. */
export function parseSegment(segment) {
  if ( typeof segment !== "string" || segment[16] !== ":" ) return null;
  const advancementId = segment.slice(0, 16);
  const uuid = segment.slice(17);
  if ( !isId(advancementId) || !isCompendiumUuid(uuid) ) return null;
  return { advancementId, uuid: normalizeUuid(uuid) };
}

/** Is this a well-formed path (role, then segments)? */
export function isPath(path) {
  return Array.isArray(path) && path.length > 0 && ROLES.includes(path[0]) && path.slice(1).every(s => parseSegment(s));
}

/** The key that identifies one recipe step: path + advancement + level. */
export function stepKey({ path, advancementId, level }) {
  return `${(path ?? []).map(s => (s.includes(":") ? formatSegment(...s.split(/:(.*)/s).slice(0, 2)) : s)).join("/")}#${advancementId}@${level}`;
}

/**
 * Index recipe steps by key. Duplicate keys keep the first and are reported.
 * @returns {{ byKey: Map<string, object>, duplicates: object[] }}
 */
export function indexRecipe(steps = []) {
  const byKey = new Map();
  const duplicates = [];
  for ( const step of steps ) {
    const key = stepKey(step);
    if ( byKey.has(key) ) duplicates.push(step);
    else byKey.set(key, step);
  }
  return { byKey, duplicates };
}

/**
 * Summarise step results for the wizard ("needs attention") and the validator.
 * @param {{ status: "done"|"auto"|"needsInput"|"invalid"|"blocked" }[]} results
 */
export function summarize(results) {
  const by = s => results.filter(r => r.status === s);
  const needsInput = by("needsInput");
  const invalid = by("invalid");
  const blocked = by("blocked");
  return { complete: !needsInput.length && !invalid.length && !blocked.length, needsInput, invalid, blocked,
    done: by("done").length, auto: by("auto").length };
}

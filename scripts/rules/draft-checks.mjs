/**
 * Validator checks that need no Foundry (PLAN 2.6): the draft envelope (shape, schema, world, rules), the
 * built character's structure from a plain summary (validate.mjs `actorSummary`), details, portrait and the
 * character limit. validate.mjs runs these together with the rules checks.
 */

import { ERRORS, STEPS, ROLES, makeError, checkDraftShape, checkImage, migrateDraft } from "../contracts.mjs";

/**
 * Structure, schema, world and rules. Stops at the first failing layer: a draft that doesn't parse can't
 * be checked further.
 * @param {object} draft
 * @param {{ worldId: string, rules: string }} world
 * @returns {{ draft: object|null, errors: object[] }}  `draft` is the migrated copy when usable.
 */
export function checkEnvelope(draft, { worldId, rules }) {
  let current;
  try {
    ({ draft: current } = migrateDraft(draft));
  } catch ( err ) {
    return { draft: null, errors: [makeError(err.code === "SCHEMA_TOO_NEW" ? "SCHEMA_TOO_NEW" : "BAD_REQUEST", { message: err.message })] };
  }
  const problems = checkDraftShape(current);
  if ( problems.length ) return { draft: null, errors: [makeError("BAD_REQUEST", { problems: problems.slice(0, 20) })] };
  if ( current.worldId !== worldId ) return { draft: null, errors: [makeError("WORLD_MISMATCH", { draft: current.worldId, world: worldId })] };
  if ( current.rules !== rules ) return { draft: null, errors: [makeError("RULES_MISMATCH", { draft: current.rules, world: rules })] };
  return { draft: current, errors: [] };
}

/**
 * The built character's structure, from a plain summary:
 * `{ level, hp, items: [{ id, name, type, source, origin, levels }] }` where `source` is the normalised
 * compendium UUID and `origin` the `advancementOrigin` flag ("<itemId>.<advancementId>").
 * - exactly one species, background and class; at most one subclass; level 1 (class levels 1);
 * - hit points above 0;
 * - every item is allowed by the catalog or granted by an item on the character (provenance).
 * @param {object} summary
 * @param {{ isAllowed: (uuid: string) => boolean }} catalog
 * @returns {object[]} makeError() objects
 */
export function checkBuiltStructure(summary, { isAllowed }) {
  const errors = [];
  const items = summary?.items ?? [];
  const byType = type => items.filter(i => i.type === type);
  const role = { species: "race", background: "background", class: "class" };
  const missing = { species: "SPECIES_MISSING", background: "BACKGROUND_MISSING", class: "CLASS_MISSING" };
  const notAllowed = { species: "SPECIES_NOT_ALLOWED", background: "BACKGROUND_NOT_ALLOWED", class: "CLASS_NOT_ALLOWED" };
  for ( const r of ROLES ) {
    const found = byType(role[r]);
    if ( !found.length ) errors.push(makeError(missing[r]));
    else if ( found.length > 1 ) errors.push(makeError(notAllowed[r], { count: found.length, items: found.map(i => i.name) }));
  }
  if ( byType("subclass").length > 1 ) errors.push(makeError("CLASS_NOT_ALLOWED", { subclasses: byType("subclass").map(i => i.name) }));
  const classes = byType("class");
  if ( summary?.level !== 1 || classes.some(c => c.levels !== 1) ) {
    errors.push(makeError("CLASS_NOT_ALLOWED", { level: summary?.level ?? null, classLevels: classes.map(c => c.levels) }));
  }
  if ( !(summary?.hp > 0) ) errors.push(makeError("APPLY_FAILED", { hp: summary?.hp ?? null }));

  // Provenance: allowed itself, or granted by an advancement of an item on the character.
  const ids = new Set(items.map(i => i.id));
  const orphans = items.filter(i => {
    if ( i.source && isAllowed(i.source) ) return false;
    const parent = typeof i.origin === "string" ? i.origin.split(".")[0] : null;
    return !(parent && ids.has(parent) && parent !== i.id);
  });
  if ( orphans.length ) errors.push(makeError("UNKNOWN_ITEM", { items: orphans.map(i => ({ name: i.name, source: i.source ?? null })) }));
  return errors;
}

/** Name present (after trimming). */
export function checkDetails(draft) {
  return String(draft?.details?.name ?? "").trim() ? [] : [makeError("NAME_REQUIRED")];
}

/** A portrait sent with the submission (optional): WebP within the size limits. */
export function checkPortraitImage(image) {
  if ( image === undefined || image === null ) return [];
  const problems = checkImage(image);
  return problems.length ? [makeError("BAD_IMAGE", { problems })] : [];
}

/**
 * The player's character limit (A4; the setting comes in PLAN 2.10).
 * @param {{ limit?: number|null, existing?: number }} options   `limit` null/undefined = no limit.
 */
export function checkCharacterLimit({ limit, existing = 0 } = {}) {
  if ( limit === null || limit === undefined ) return [];
  return existing >= limit ? [makeError("CHARACTER_LIMIT", { limit, existing })] : [];
}

/** Errors grouped by the wizard step to revisit, in step order: `[{ step, errors }]`. */
export function errorsByStep(errors) {
  const groups = new Map(STEPS.map(s => [s, []]));
  for ( const e of errors ) groups.get(ERRORS[e.code]?.step ?? e.step ?? "start")?.push(e);
  return [...groups].filter(([, list]) => list.length).map(([step, list]) => ({ step, errors: list }));
}

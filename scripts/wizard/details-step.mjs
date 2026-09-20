/**
 * The Details step (PLAN 3.7): the character's name and the rest of what makes them a person. Only the name is
 * required; everything else is optional. 2014 characters also fill in personality traits, ideals, bonds and
 * flaws, which the background's tables can roll for them (flavour, rolled locally — never validated).
 */

import { DETAIL_FIELDS, LIMITS } from "../contracts.mjs";

/** Fields that get a text area rather than a line. */
const LONG = Object.freeze(["appearance", "biography", "traits", "ideals", "bonds", "flaws"]);

/** The 2014 personality fields, and the table that rolls each one. */
export const PERSONALITY = Object.freeze({
  traits: "Personality Traits", ideals: "Ideals", bonds: "Bonds", flaws: "Flaws"
});

/** The longest a field may be (contracts.mjs). */
export const maxLength = field => (field === "name" ? LIMITS.nameMaxLength
  : LONG.includes(field) ? LIMITS.longTextMaxLength : LIMITS.shortTextMaxLength);

/** Which fields this rules version shows, in order. */
export function fieldsFor(rules) {
  const personality = Object.keys(PERSONALITY);
  return DETAIL_FIELDS.filter(f => (rules === "legacy") || !personality.includes(f));
}

/** Set one field, trimmed to its limit so a paste can't break the draft. */
export function setDetail(draft, field, value) {
  if ( !DETAIL_FIELDS.includes(field) ) return draft;
  draft.details[field] = String(value ?? "").slice(0, maxLength(field));
  return draft;
}

/**
 * The screen's model.
 * @param {object} draft
 * @param {object} options
 * @param {string} options.rules
 * @param {Record<string, string>} [options.tables]   Field → the name of the table that rolls it.
 */
export function detailsModel(draft, { rules, tables = {} } = {}) {
  const details = draft?.details ?? {};
  const fields = fieldsFor(rules).map(key => ({
    key,
    value: details[key] ?? "",
    long: LONG.includes(key),
    required: key === "name",
    max: maxLength(key),
    table: tables[key] ?? null
  }));
  return {
    fields,
    name: details.name ?? "",
    hasName: !!String(details.name ?? "").trim(),
    personality: rules === "legacy"
  };
}

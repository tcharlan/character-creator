/**
 * The Details step (PLAN 3.7): the character's name and the rest of what makes them a person. Only the name is
 * required; everything else is optional. Personality traits, ideals, bonds and flaws are there in both rule
 * sets, and where the world has a table for that background they can be rolled (flavour, rolled locally —
 * never validated).
 *
 * Each field is asked for in the way it is answered (PLAN 3.11): the alignment as a list, the age as a number,
 * the height as feet and inches, the weight with its unit. What the draft stores is still plain text, because
 * that is what a dnd5e character sheet keeps ("5 ft 7 in", "150 lb").
 */

import { DETAIL_FIELDS, LIMITS } from "../contracts.mjs";
import { detailProblem } from "../rules/draft-checks.mjs";

/** Fields that get a text area rather than a line. */
const LONG = Object.freeze(["appearance", "biography", "traits", "ideals", "bonds", "flaws"]);

/** How each field is asked for; anything not listed is a line of text. */
const KINDS = Object.freeze({ alignment: "choice", age: "number", height: "height", weight: "amount" });

/** Units, as they are stored and shown. */
export const UNITS = Object.freeze({ feet: "ft", inches: "in", weight: "lb" });

/** The 2014 personality fields, and the table that rolls each one. */
export const PERSONALITY = Object.freeze({
  traits: "Personality Traits", ideals: "Ideals", bonds: "Bonds", flaws: "Flaws"
});

/** Alignments, for the list; dnd5e's own labels where they are there. */
const FALLBACK_ALIGNMENTS = Object.freeze(["Lawful Good", "Neutral Good", "Chaotic Good", "Lawful Neutral",
  "True Neutral", "Chaotic Neutral", "Lawful Evil", "Neutral Evil", "Chaotic Evil", "Unaligned"]);

/** The longest a field may be (contracts.mjs). */
export const maxLength = field => (field === "name" ? LIMITS.nameMaxLength
  : LONG.includes(field) ? LIMITS.longTextMaxLength : LIMITS.shortTextMaxLength);

/**
 * The fields the step shows, in order — the same in both rule sets. The 2024 rules dropped the personality
 * tables from backgrounds, but a character still has a trait, an ideal, a bond and a flaw, and the sheet has
 * somewhere to put them; where the world holds a table for that background, they can still be rolled.
 */
export function fieldsFor() {
  return [...DETAIL_FIELDS];
}

/** The alignments offered, as labels (what the sheet stores). */
export function alignmentOptions() {
  const config = globalThis.CONFIG?.DND5E?.alignments;
  const labels = config ? Object.values(config).map(a => (typeof a === "string" ? a : a?.label)).filter(Boolean)
    : [...FALLBACK_ALIGNMENTS];
  return labels;
}

/** "5 ft 7 in" → { feet: "5", inches: "7" }; a plain number is taken as feet. */
export function parseHeight(value) {
  const text = String(value ?? "").trim();
  if ( !text ) return { feet: "", inches: "" };
  const feet = text.match(/(\d+)\s*(?:ft|feet|')/i) ?? (/^\d+$/.test(text) ? [null, text] : null);
  const inches = text.match(/(\d+)\s*(?:in|inches|")/i);
  return { feet: feet?.[1] ?? "", inches: inches?.[1] ?? "" };
}

/** { feet, inches } → "5 ft 7 in" (either part may be missing). */
export function composeHeight({ feet, inches } = {}) {
  const part = (value, unit) => (String(value ?? "").trim() === "" ? null : `${Number(value)} ${unit}`);
  return [part(feet, UNITS.feet), part(inches, UNITS.inches)].filter(Boolean).join(" ");
}

/** "150 lb" → "150" (the number the field shows). */
export function parseAmount(value) {
  return String(value ?? "").match(/-?\d+(?:\.\d+)?/)?.[0] ?? "";
}

/** "150" → "150 lb". */
export function composeAmount(value, unit) {
  const text = String(value ?? "").trim();
  return text === "" ? "" : `${text} ${unit}`;
}

/** Set one field, trimmed to its limit so a paste can't break the draft. */
export function setDetail(draft, field, value) {
  if ( !DETAIL_FIELDS.includes(field) ) return draft;
  draft.details[field] = String(value ?? "").slice(0, maxLength(field));
  return draft;
}

/** Set one part of the height; the other part is kept. */
export function setHeightPart(draft, part, value) {
  const current = parseHeight(draft.details.height);
  return setDetail(draft, "height", composeHeight({ ...current, [part]: value }));
}

/** Set a field that carries a unit (the weight). */
export function setAmount(draft, field, value, unit) {
  return setDetail(draft, field, composeAmount(value, unit));
}

/**
 * The screen's model.
 * @param {object} draft
 * @param {object} options
 * @param {string} options.rules
 * @param {Record<string, string>} [options.tables]   Field → the name of the table that rolls it.
 */
export function detailsModel(draft, { tables = {}, locked = [] } = {}) {
  const details = draft?.details ?? {};
  const fields = fieldsFor().map(key => {
    const value = details[key] ?? "";
    const problem = detailProblem(key, value);
    const kind = KINDS[key] ?? (LONG.includes(key) ? "long" : "text");
    const field = {
      key,
      kind,
      value,
      long: kind === "long",
      required: key === "name",
      max: maxLength(key),
      table: tables[key] ?? null,
      // Settled by the dice (D31): shown, not changed.
      locked: locked.includes(key),
      problem: problem ? `CHARCREATOR.Details.Problem.${problem}` : null
    };
    if ( kind === "choice" ) {
      field.options = alignmentOptions().map(label => ({ value: label, selected: label === value }));
    }
    if ( kind === "height" ) {
      const { feet, inches } = parseHeight(value);
      field.parts = [{ part: "feet", value: feet, unit: UNITS.feet }, { part: "inches", value: inches, unit: UNITS.inches }];
    }
    if ( kind === "amount" ) {
      field.amount = parseAmount(value);
      field.unit = UNITS.weight;
    }
    return field;
  });
  return {
    fields,
    anyLocked: fields.some(f => f.locked),
    name: details.name ?? "",
    hasName: !!String(details.name ?? "").trim(),
    personality: fields.some(f => Object.keys(PERSONALITY).includes(f.key))
  };
}

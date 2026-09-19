/**
 * The draft's details step → dnd5e 5.3 character data (PLAN 2.7). Pure. Everything the player typed is
 * plain text: the one HTML field (biography) gets it escaped, paragraph by paragraph.
 */

/** Draft detail field → path under `system.details` (dnd5e CharacterData / DetailsField). */
export const DETAIL_PATHS = Object.freeze({
  pronouns: "gender",          // dnd5e's free-text "Gender" field, shown on the sheet next to age and height
  alignment: "alignment",
  age: "age",
  height: "height",
  weight: "weight",
  eyes: "eyes",
  hair: "hair",
  skin: "skin",
  appearance: "appearance",
  traits: "trait",
  ideals: "ideal",
  bonds: "bond",
  flaws: "flaw"
});

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
export const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ESCAPES[c]);

/** Plain text → HTML paragraphs (blank lines separate paragraphs; single newlines become <br>). */
export function textToHtml(text) {
  const paragraphs = String(text ?? "").replace(/\r\n?/g, "\n").trim().split(/\n\s*\n/).filter(p => p.trim());
  return paragraphs.map(p => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`).join("");
}

/**
 * Actor data for the details: `{ name, system: { details } }` (merge into the creation data).
 * @param {object} details   draft.details
 * @param {string} fallbackName
 */
export function detailsData(details = {}, fallbackName = "") {
  const out = {};
  for ( const [field, path] of Object.entries(DETAIL_PATHS) ) {
    const v = String(details[field] ?? "").trim();
    if ( v ) out[path] = v;
  }
  const bio = textToHtml(details.biography);
  if ( bio ) out.biography = { value: bio };
  return { name: String(details.name ?? "").trim() || fallbackName, system: { details: out } };
}

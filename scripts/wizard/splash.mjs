/**
 * The backdrop behind each step (D28). Three layers, in order of preference:
 *  1. the GM's own picture for that step (the `stepArt` setting), shown on its own;
 *  2. otherwise the step's sigil — an original line drawing bundled with the module (assets/splash/) — with,
 *     where the player has picked something that fits the step, that option's own picture (the GM's picture
 *     per option, else the compendium's) blurred and darkened behind it.
 * Nothing here is rules content or third-party art: the sigils are the module's own, and the picked option's
 * picture is the one the wizard already shows beside it.
 *
 * Pure: no Foundry globals.
 */

import { MODULE_ID, STEPS } from "../contracts.mjs";
import { artFor } from "./options-step.mjs";

/** Whose picture sits behind a step: its own pick on the option steps, the class after that. */
const ART_ROLE = Object.freeze({
  species: "species", class: "class", background: "background", abilities: "class", choices: "class",
  equipment: "class", spells: "class", details: "class", portrait: "class", review: "class"
});

/** Foundry's placeholder icons say nothing about the option, so they never become a backdrop. */
const PLACEHOLDER = /^icons\/svg\//;

/** The sigil for a step, as a path Foundry serves. */
export const sigilPath = step => `modules/${MODULE_ID}/assets/splash/${STEPS.includes(step) ? step : "start"}.svg`;

/**
 * The backdrop for a step.
 * @param {string} step
 * @param {object} [options]
 * @param {Record<string, string|null>} [options.picks]   The draft's picks by role.
 * @param {{ get?: (uuid: string) => { img?: string }|undefined }} [options.catalog]
 * @param {Record<string, string>} [options.optionArt]    The GM's picture per option (normalised).
 * @param {Record<string, string>} [options.stepArt]      The GM's picture per step (normalised).
 * @returns {{ step: string, sigil: string|null, image: string|null, source: "gm"|"pick"|null }}
 */
export function splashFor(step, { picks = {}, catalog = null, optionArt = {}, stepArt = {} } = {}) {
  if ( stepArt[step] ) return { step, sigil: null, image: stepArt[step], source: "gm" };
  const uuid = ART_ROLE[step] ? picks?.[ART_ROLE[step]] : null;
  let image = null;
  if ( uuid ) {
    const own = catalog?.get?.(uuid)?.img ?? null;
    image = artFor(uuid, optionArt, own && !PLACEHOLDER.test(own) ? own : null);
  }
  return { step, sigil: sigilPath(step), image, source: image ? "pick" : null };
}

/**
 * The wizard's step model (PLAN 3.1). Pure: which steps the player can reach, what state each is in, and where
 * Back and Next go. The shell (app.mjs) renders it; the step panes (PLAN 3.2–3.9) fill each step in.
 */

import { STEPS, ERRORS } from "../contracts.mjs";

/** The steps shown in the banner (CREATION-FLOW.md); "start" is the opening screen, not a banner step. */
export const BANNER_STEPS = Object.freeze(STEPS.filter(s => s !== "start"));

/** Roman numerals for the banner. */
export const NUMERALS = Object.freeze(["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"]);

/** What a step needs before it can be opened: the picks it builds on. */
const REQUIRES = Object.freeze({
  species: [], class: [], background: [], abilities: [],
  choices: ["species", "background", "class"],
  equipment: ["class", "background"],
  spells: ["class"],
  details: [], portrait: [],
  review: ["species", "background", "class"]
});

/** A step's state: `done`, `current`, `attention` (its own errors), `todo`, or `locked` (picks missing). */
export function stepState(step, { current, draft, errorsByStep, visited = [] }) {
  const missing = REQUIRES[step].filter(role => !draft?.picks?.[role]);
  if ( missing.length ) return step === current ? "current" : "locked";
  if ( step === current ) return "current";
  if ( errorsByStep?.[step]?.length ) return "attention";
  return visited.includes(step) ? "done" : "todo";
}

/**
 * The banner model.
 * @param {object} options
 * @param {string} options.current                    Current step key.
 * @param {object} options.draft
 * @param {Record<string, object[]>} options.errorsByStep   Errors keyed by step (validator output, grouped).
 * @param {Record<string, string>} [options.labels]   Step key → what the player picked ("High Elf").
 * @param {string[]} [options.visited]
 * @returns {{ key, name, numeral, state, label, locked }[]}
 */
export function bannerSteps({ current, draft, errorsByStep = {}, labels = {}, visited = [] }) {
  return BANNER_STEPS.map((key, i) => {
    const state = stepState(key, { current, draft, errorsByStep, visited });
    return { key, numeral: NUMERALS[i], state, locked: state === "locked",
      label: labels[key] ?? "", count: errorsByStep[key]?.length ?? 0 };
  });
}

/** Can the player open this step now? */
export const canOpen = (step, draft) => BANNER_STEPS.includes(step) && REQUIRES[step].every(role => !!draft?.picks?.[role]);

/** The step Back or Next goes to, skipping steps whose picks are missing; null at the ends. */
export function moveStep(current, direction, draft) {
  const i = BANNER_STEPS.indexOf(current);
  if ( i < 0 ) return direction > 0 ? BANNER_STEPS[0] : null;
  for ( let j = i + direction; j >= 0 && j < BANNER_STEPS.length; j += direction ) {
    if ( canOpen(BANNER_STEPS[j], draft) ) return BANNER_STEPS[j];
  }
  return null;
}

/** Validator errors grouped by their step (`makeError` carries the step). */
export function groupErrors(errors = []) {
  const out = {};
  for ( const e of errors ) {
    const step = ERRORS[e.code]?.step ?? e.step ?? "start";
    (out[step] ??= []).push(e);
  }
  return out;
}

/** A short summary for the footer: how many steps need attention, and whether the build can be submitted. */
export function attention(errorsByStep) {
  const steps = Object.keys(errorsByStep).filter(s => errorsByStep[s].length);
  return { steps, errors: steps.reduce((n, s) => n + errorsByStep[s].length, 0), ready: !steps.length };
}

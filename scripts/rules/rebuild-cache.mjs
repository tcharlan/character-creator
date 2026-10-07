/**
 * Rebuilding from the last change only (D38). A builder made here remembers its last build and the copy of the
 * character it kept at the end of every level; the next build resumes from the level before the first one a
 * change reaches (`resume.mjs`), instead of replaying the whole character again. The random loop rebuilds once a
 * round and goes a level at a time, so on a level-11 character most rounds replay a level or two, not eleven.
 *
 * One builder per sequence of related builds (one roll of the dice, one GM check): its options — the catalog,
 * the hit point method — stay the same throughout, which is what makes its checkpoints reusable.
 */

import { buildCharacter } from "./build.mjs";
import { firstChangedLevel } from "./resume.mjs";

/**
 * @param {object} options   buildCharacter's options (catalog, fill, withOptions, hitPointMethod, slice…).
 * @returns {(input: object) => Promise<object>}   Takes buildInput(draft), returns the build.
 */
export function incrementalBuilder(options) {
  let last = null;
  return async input => {
    let from = null;
    if ( last ) {
      const level = firstChangedLevel({ input: last.input, results: last.results }, input);
      if ( level > 1 ) from = last.checkpoints.get(Math.min(level - 1, input.level ?? 1)) ?? null;
    }
    const checkpoints = new Map(from ? [...last.checkpoints].filter(([lv]) => lv <= from.level) : []);
    const built = await buildCharacter(input, { ...options, from, onLevel: (lv, cp) => checkpoints.set(lv, cp) });
    last = { input: structuredClone(input), results: built.results, checkpoints };
    return built;
  };
}

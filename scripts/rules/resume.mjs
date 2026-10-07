/**
 * Where a rebuild has to start (D38): the earliest character level a change can reach. Everything before it
 * stands as the last build left it, so the replay resumes from that build's checkpoint at the level before.
 * Pure: compares the inputs and the previous build's results; no Foundry.
 */

import { levelSchedule } from "./build.mjs";
import { stepKey } from "./paths.mjs";

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * @param {object} prev                 The last build's input (`buildInput(draft)`) and its `results`.
 * @param {object} prev.input
 * @param {object[]} prev.results       From buildCharacter(): each with `key` and `at` (the character level).
 * @param {object} next                 The new input.
 * @returns {number}  The first character level to replay: 1 means from the start; `next.level + 1` means
 *   nothing before the end changed (only levels were dropped, or nothing at all).
 */
export function firstChangedLevel(prev, next) {
  const a = prev?.input;
  if ( !a || !prev.results ) return 1;
  // Who the character is: everything rests on these.
  if ( !same(a.picks, next.picks) || !same(a.base, next.base) || !same(a.hitPoints, next.hitPoints) ) return 1;

  let first = Math.max(a.level ?? 1, next.level ?? 1) + 1;
  // Which class each level goes to (D37).
  const order = input => levelSchedule(input.level ?? 1, (input.multiclass ?? []).map(m => ({ ...m, root: m.uuid })))
    .map(s => (s ? `${s.root}@${s.classLevel}` : null));
  const was = order(a);
  const now = order(next);
  for ( let c = 1; c < Math.max(was.length, now.length); c++ ) {
    if ( was[c] !== now[c] ) {
      first = Math.min(first, c);
      break;
    }
  }

  // Answers: one that changed, appeared or went is replayed from the level it was met at.
  const at = new Map(prev.results.map(r => [r.key, r.at ?? 1]));
  const before = new Map((a.steps ?? []).map(s => [stepKey(s), s.data]));
  const after = new Map((next.steps ?? []).map(s => [stepKey(s), s.data]));
  for ( const key of new Set([...before.keys(), ...after.keys()]) ) {
    if ( same(before.get(key), after.get(key)) ) continue;
    first = Math.min(first, at.get(key) ?? 1);
  }
  return Math.min(first, (next.level ?? 1) + 1);
}

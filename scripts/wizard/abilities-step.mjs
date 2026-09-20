/**
 * The ability-scores step (PLAN 3.3), as plain logic: what each method shows, what a click changes, and what the
 * player still has to do. The rules themselves live in `rules/abilities.mjs`; this only shapes them for the screen.
 */

import { ABILITIES, ABILITY_METHODS } from "../contracts.mjs";
import { POINT_BUY, STANDARD_ARRAY, ABILITY_ROLL, pointBuyCost } from "../rules/abilities.mjs";

/** A fresh set of base scores for a method: point buy starts at the minimum, the others start empty. */
export function startingScores(method) {
  if ( method === "pointBuy" ) return Object.fromEntries(ABILITIES.map(a => [a, POINT_BUY.min]));
  if ( method === null ) return null;
  return Object.fromEntries(ABILITIES.map(a => [a, null]));
}

/** Switch method: the scores that belong to the old one go, and a rolled draft keeps its roll (A10). */
export function setMethod(draft, method) {
  if ( !ABILITY_METHODS.includes(method) || (draft.abilities.method === method) ) return draft;
  draft.abilities = { method, base: startingScores(method), roll: method === "rolled" ? draft.abilities.roll : null };
  return draft;
}

/** Point buy: raise or lower one score, within 8–15 and the 27 points. */
export function spendPoint(draft, ability, delta) {
  const base = { ...(draft.abilities.base ?? startingScores("pointBuy")) };
  const next = (base[ability] ?? POINT_BUY.min) + delta;
  if ( (next < POINT_BUY.min) || (next > POINT_BUY.max) ) return draft;
  const candidate = { ...base, [ability]: next };
  if ( pointBuyCost(candidate).spent > POINT_BUY.budget ) return draft;
  draft.abilities.base = candidate;
  return draft;
}

/**
 * Standard array and rolled: put one of the values on an ability. Each value in the pool is used once, and a
 * pool can hold the same number twice (two 12s in a roll), so a value only swaps when no copy is spare.
 */
export function assignValue(draft, ability, value) {
  const base = { ...startingScores(draft.abilities.method ?? "standardArray"), ...(draft.abilities.base ?? {}) };
  const previous = base[ability] ?? null;
  if ( value === null ) base[ability] = null;
  else {
    const copies = poolFor(draft.abilities).filter(v => v === value).length;
    const holders = ABILITIES.filter(a => (a !== ability) && (base[a] === value));
    if ( holders.length >= copies ) base[holders[0]] = previous;   // none spare: trade with whoever has it
    base[ability] = value;
  }
  draft.abilities.base = base;
  return draft;
}

/** The pool a method assigns from: the standard array, or the rolled results. */
export function poolFor(abilities) {
  if ( abilities?.method === "standardArray" ) return [...STANDARD_ARRAY];
  if ( abilities?.method === "rolled" ) return [...(abilities.roll?.results ?? [])];
  return [];
}

/**
 * The screen's model.
 * @param {object} draft
 * @param {object} options
 * @param {string[]} options.allowedMethods         From the GM's settings.
 * @param {Record<string, object>} [options.finals] The built character's abilities (value and modifier).
 * @returns {{ method, methods, rows, pointBuy, pool, rolled, complete }}
 */
export function abilitiesModel(draft, { allowedMethods = ABILITY_METHODS, finals = {} } = {}) {
  const abilities = draft?.abilities ?? {};
  const method = abilities.method;
  const base = abilities.base ?? {};
  const pool = poolFor(abilities);
  const used = ABILITIES.map(a => base[a]).filter(v => Number.isInteger(v));
  const spare = [...pool];
  for ( const value of used ) {
    const at = spare.indexOf(value);
    if ( at >= 0 ) spare.splice(at, 1);
  }
  const cost = method === "pointBuy" ? pointBuyCost(base) : null;

  const rows = ABILITIES.map(key => {
    const score = Number.isInteger(base[key]) ? base[key] : null;
    const final = finals[key] ?? null;
    return {
      key,
      // Outside Foundry (unit tests) there is no CONFIG: fall back to the abbreviation.
      label: globalThis.CONFIG?.DND5E?.abilities?.[key]?.label ?? key.toUpperCase(),
      abbreviation: key.toUpperCase(),
      score,
      cost: (score !== null) && (method === "pointBuy") ? POINT_BUY.cost[score] ?? null : null,
      canRaise: (method === "pointBuy") && (score !== null) && (score < POINT_BUY.max)
        && (pointBuyCost({ ...base, [key]: score + 1 }).spent <= POINT_BUY.budget),
      canLower: (method === "pointBuy") && (score !== null) && (score > POINT_BUY.min),
      // For the assigned methods: this ability's value plus the ones still spare.
      // Its own value plus the spare ones — duplicates kept, since a roll can give the same number twice.
      choices: (method === "pointBuy") ? [] : [...(score !== null ? [score] : []), ...spare].sort((a, b) => b - a),
      final: final?.value ?? null,
      bonus: (final && (score !== null)) ? final.value - score : null,
      modifier: final?.mod ?? null
    };
  });

  return {
    method: method ?? null,
    methods: ABILITY_METHODS.filter(m => allowedMethods.includes(m)).map(m => ({ key: m, selected: m === method })),
    onlyOne: allowedMethods.length === 1,
    rows,
    pointBuy: cost ? { spent: cost.spent, remaining: cost.remaining, budget: POINT_BUY.budget } : null,
    pool,
    spare,
    spareText: spare.join(", "),
    rolled: method === "rolled" ? { rolled: !!abilities.roll, formula: ABILITY_ROLL.formula, count: ABILITY_ROLL.count,
      results: abilities.roll?.results ?? [], resultsText: (abilities.roll?.results ?? []).join(", ") } : null,
    complete: (method !== null) && ABILITIES.every(a => Number.isInteger(base[a]))
      && ((method !== "pointBuy") || (cost.spent === POINT_BUY.budget))
  };
}

/*
 * SPIKE 1.3 — throwaway. Not part of the module.
 *
 * Questions: can the GM side rebuild a character from its recipe alone (plain JSON, as stored in the
 * draft) and get exactly what the player built? Does replay notice a tampered recipe (dnd5e's apply()
 * validates nothing)? How long does a full rebuild take (D18 rebuilds on every change)?
 *
 * Run via `npm run test:foundry` (Quench batch character-creator.spike-1-3), or in the console:
 *   const report = await (await import("/modules/character-creator/spike/replay.mjs")).run();
 */

import {
  PICKS, BASE_SCORES, watchDb, buildCharacter, findFirst, makeActor, embed, getAdv, snapshot, compare,
  normalizeUuid, schemaInitials, spellListUuids
} from "./lib.mjs";

/** Error codes the replay validator reports (a preview of contracts.mjs error codes). */
export const CODES = {
  UNKNOWN_ITEM: "UNKNOWN_ITEM",           // a step names an item the replayed actor doesn't have
  UNKNOWN_ADVANCEMENT: "UNKNOWN_ADVANCEMENT",
  NOT_ALLOWED: "NOT_ALLOWED",             // a Trait key outside that advancement's grants/pools
  TOO_MANY_PICKS: "TOO_MANY_PICKS",
  UNFULFILLED: "UNFULFILLED",             // a required grant/choice left open
  ASI_OVER_LIMIT: "ASI_OVER_LIMIT",
  ASI_LOCKED: "ASI_LOCKED",
  NOT_OFFERED: "NOT_OFFERED",             // an item UUID the advancement doesn't offer
  MISSING_STEP: "MISSING_STEP",           // an advancement needing input has no step in the recipe
  APPLY_FAILED: "APPLY_FAILED"
};

/* -------------------------------------------- */
/*  Recipe                                      */
/* -------------------------------------------- */

/** Plain-JSON recipe from an interactive build: picks, base scores and each step's apply data. */
export function extractRecipe(built, rules, base = BASE_SCORES) {
  const { actor, steps, ids } = built;
  const src = id => normalizeUuid(actor.items.get(id)?._stats?.compendiumSource);
  return {
    schema: 0, rules, base: { ...base },
    picks: { species: src(ids.species), background: src(ids.background), class: src(ids.class) },
    steps: steps.map(s => ({ item: src(s.itemId), advancementId: s.advancementId, level: s.level, data: s.data }))
  };
}

/* -------------------------------------------- */
/*  Replay + validation                         */
/* -------------------------------------------- */

/**
 * Rebuild a character from a recipe on a fresh scratch actor, validating every step against dnd5e's
 * own advancement data before and after applying it.
 * @returns {Promise<{actor, errors: {code, step, detail}[]}>}
 */
export async function replay(recipe) {
  const errors = [];
  const fail = (code, step, detail) => errors.push({ code, step, detail });
  const actor = makeActor(recipe.base);

  const pointer = { species: "system.details.race", background: "system.details.background",
    class: "system.details.originalClass" };
  for ( const role of ["species", "background", "class"] ) {
    const doc = await fromUuid(recipe.picks[role]);
    if ( !doc ) {
      fail(CODES.UNKNOWN_ITEM, role, recipe.picks[role]);
      continue;
    }
    const item = embed(actor, doc, role === "class" ? { "system.levels": 1 } : {});
    actor.updateSource({ [pointer[role]]: item.id });
  }
  actor.reset();

  const applied = new Set();
  for ( const [i, step] of recipe.steps.entries() ) {
    const label = `#${i} ${step.item?.split(".").pop()}/${step.advancementId}`;
    const item = actor.items.find(it => normalizeUuid(it._stats?.compendiumSource) === step.item);
    if ( !item ) {
      fail(CODES.UNKNOWN_ITEM, label, step.item);
      continue;
    }
    const adv = item.advancement.byId[step.advancementId];
    if ( !adv ) {
      fail(CODES.UNKNOWN_ADVANCEMENT, label, step.advancementId);
      continue;
    }
    const data = foundry.utils.deepClone(step.data ?? {});
    for ( const e of await checkBefore(adv, step.level, data, recipe) ) fail(e.code, label, e.detail);
    try {
      await adv.apply(step.level, data);
    } catch ( err ) {
      fail(CODES.APPLY_FAILED, label, err.message);
    }
    actor.reset();
    const after = getAdv(actor, item.id, adv.id);
    for ( const e of await checkAfter(after) ) fail(e.code, label, e.detail);
    applied.add(`${item.id}.${adv.id}.${step.level}`);
  }

  // Every advancement that needs input must have had a step (species/background 0–1, class/subclass 1).
  for ( const item of actor.items ) {
    const levels = ["class", "subclass"].includes(item.type) ? [1] : [0, 1];
    for ( const level of levels ) {
      for ( const adv of (item.advancement?.byLevel?.[level] ?? []).filter(a => a.appliesToClass) ) {
        if ( adv.type === "ScaleValue" || applied.has(`${item.id}.${adv.id}.${level}`) ) continue;
        if ( adv.type === "ItemChoice" && !(adv.configuration.choices[level]?.count) ) continue;
        fail(CODES.MISSING_STEP, `${item.name}/${adv.title}`, { type: adv.type, level });
      }
    }
  }
  actor.reset();
  return { actor, errors };
}

/** Checks on the data before apply(), using the advancement's own configuration. */
async function checkBefore(adv, level, data, recipe) {
  const out = [];
  const config = adv.configuration;
  switch ( adv.type ) {
    case "Trait": {
      const chosen = data.chosen ?? [];
      if ( chosen.length > adv.maxTraits ) {
        out.push({ code: CODES.TOO_MANY_PICKS, detail: { chosen: chosen.length, max: adv.maxTraits } });
      }
      // What dnd5e itself would offer this actor right now for this advancement.
      const { available } = await adv.unfulfilledChoices(new Set());
      const allowed = new Set(config.grants);
      for ( const a of available ) a.choices.asSet(allowed);
      const bad = chosen.filter(k => !allowed.has(k));
      if ( bad.length ) out.push({ code: CODES.NOT_ALLOWED, detail: bad });
      break;
    }
    case "ItemGrant": {
      const offered = new Set((config.items ?? []).map(i => normalizeUuid(i.uuid)));
      const required = (config.items ?? []).filter(i => !config.optional || !i.optional).map(i => normalizeUuid(i.uuid));
      const selected = (data.selected ?? []).map(normalizeUuid);
      const bad = selected.filter(u => !offered.has(u));
      if ( bad.length ) out.push({ code: CODES.NOT_OFFERED, detail: bad });
      const missing = required.filter(u => !selected.includes(u));
      if ( missing.length ) out.push({ code: CODES.UNFULFILLED, detail: missing });
      break;
    }
    case "ItemChoice": {
      const count = config.choices[level]?.count ?? 0;
      const selected = (data.selected ?? []).map(normalizeUuid);
      if ( selected.length > count ) out.push({ code: CODES.TOO_MANY_PICKS, detail: { selected: selected.length, max: count } });
      if ( selected.length < count ) out.push({ code: CODES.UNFULFILLED, detail: { selected: selected.length, needed: count } });
      const offered = await offeredByItemChoice(config, recipe.rules);
      const bad = selected.filter(u => !offered.has(u));
      if ( bad.length ) out.push({ code: CODES.NOT_OFFERED, detail: bad });
      break;
    }
    case "AbilityScoreImprovement": {
      const assignments = data.assignments ?? {};
      const fixed = config.fixed ?? {};
      let free = 0;
      for ( const [abl, n] of Object.entries(assignments) ) {
        const extra = n - (fixed[abl] ?? 0);
        if ( extra > 0 && config.locked?.has?.(abl) ) out.push({ code: CODES.ASI_LOCKED, detail: abl });
        if ( extra > (config.cap ?? Infinity) ) out.push({ code: CODES.ASI_OVER_LIMIT, detail: { abl, n, cap: config.cap } });
        free += Math.max(0, extra);
      }
      if ( free > (config.points ?? 0) ) out.push({ code: CODES.ASI_OVER_LIMIT, detail: { assigned: free, points: config.points } });
      break;
    }
    case "Size":
      if ( data.size && config.sizes?.size && !config.sizes.has(data.size) ) {
        out.push({ code: CODES.NOT_ALLOWED, detail: data.size });
      }
      break;
    case "Subclass": {
      const doc = await fromUuid(data.uuid);
      if ( !doc || doc.type !== "subclass" || doc.system.classIdentifier !== adv.item.identifier ) {
        out.push({ code: CODES.NOT_OFFERED, detail: data.uuid });
      }
      break;
    }
  }
  return out;
}

/** Checks after apply(): anything dnd5e still considers unfulfilled. */
async function checkAfter(adv) {
  const out = [];
  if ( adv?.type === "Trait" ) {
    const { available } = await adv.unfulfilledChoices();
    const open = available.filter(a => a.choices.asSet().size > 0);
    if ( open.length ) out.push({ code: CODES.UNFULFILLED, detail: open.map(a => [...a.choices.asSet()].slice(0, 5)) });
  }
  if ( adv?.type === "AbilityScoreImprovement" ) {
    const { assigned, total } = adv.points;
    if ( assigned > total ) out.push({ code: CODES.ASI_OVER_LIMIT, detail: { assigned, total } });
  }
  return out;
}

/** UUIDs an ItemChoice offers: its pool, or (empty pool) what its restriction allows (shared with the builder). */
async function offeredByItemChoice(config, rules) {
  const pool = config.pool.map(p => normalizeUuid(p.uuid));
  if ( pool.length ) return new Set(pool);
  return new Set((await spellListUuids(config, rules)).map(normalizeUuid));
}

/* -------------------------------------------- */
/*  Tamper cases                                */
/* -------------------------------------------- */

const findStep = (recipe, itemName, advId) => recipe.steps.find(s => s.item.endsWith(itemName) && s.advancementId === advId);

/** Per rule set: [id, description, expected code, mutate(recipe)]. Advancement ids from RESEARCH.md → Spike 1.1. */
const TAMPERS = {
  legacy: [
    ["T1", "Cleric takes a third class skill", CODES.TOO_MANY_PICKS,
      r => findStep(r, "tlwBnN8GmqJcTgub", "6YQrE9NkjbvhfN8F").data.chosen.push("skills:per")],
    ["T2", "Hill Dwarf drops its Dwarvish grant", CODES.UNFULFILLED,
      r => findStep(r, "UQiRQUTBcsz8gZU1", "rmcKuRQ2Laloq1xp").data.chosen = ["languages:standard:common"]],
    ["T3", "Hill Dwarf adds +2 STR to its fixed increases", CODES.ASI_OVER_LIMIT,
      r => findStep(r, "UQiRQUTBcsz8gZU1", "Z9hvZFkWUNvowbQX").data.assignments.str = 2],
    ["T4", "Acolyte's feature grant swapped for Stonecunning", CODES.NOT_OFFERED,
      r => findStep(r, "IgJkSnLiLJOWH7eK", "6grrnum72rnphzi5").data.selected = ["Compendium.dnd5e.races.Item.mQPZDRbUhgYTbXKa"]],
    ["T5", "Cleric's skill step removed", CODES.MISSING_STEP,
      r => r.steps.splice(r.steps.indexOf(findStep(r, "tlwBnN8GmqJcTgub", "6YQrE9NkjbvhfN8F")), 1)],
    ["T6", "Cleric skill outside its list (Stealth)", CODES.NOT_ALLOWED,
      r => findStep(r, "tlwBnN8GmqJcTgub", "6YQrE9NkjbvhfN8F").data.chosen = ["skills:his", "skills:ste"]]
  ],
  modern: [
    ["T1", "Fighter takes a third class skill", CODES.TOO_MANY_PICKS,
      r => findStep(r, "phbftrFighter000", "UaSYMl2io5kbXNOY").data.chosen.push("skills:per")],
    ["T2", "Sage drops its Arcana grant", CODES.UNFULFILLED,
      r => findStep(r, "phbbgSage0000000", "DMd8rikwPlZdpP1l").data.chosen = ["tool:art:calligrapher", "skills:his"]],
    ["T3", "Sage assigns +2/+2 (4 points of 3)", CODES.ASI_OVER_LIMIT,
      r => findStep(r, "phbbgSage0000000", "3O61L5uTy5jRCqJb").data.assignments = { con: 2, int: 2 }],
    ["T3b", "Sage raises a locked ability (STR)", CODES.ASI_LOCKED,
      r => findStep(r, "phbbgSage0000000", "3O61L5uTy5jRCqJb").data.assignments = { str: 2, int: 1 }],
    ["T4", "Fighting style swapped for a non-style feat (Alert)", CODES.NOT_OFFERED,
      r => findStep(r, "phbftrFighter000", "EmTANp6x6GfXFTmU").data.selected = ["Compendium.dnd5e.feats24.Item.phbftAlert000000"]],
    ["T4b", "Magic Initiate level-1 spell swapped for Fireball", CODES.NOT_OFFERED,
      r => findStep(r, "phbftMagicInitia", "ZbKHs2FVCkJVNW8p").data.selected = ["Compendium.dnd5e.spells24.Item.phbsplFireball00"]],
    ["T5", "Fighter's skill step removed", CODES.MISSING_STEP,
      r => r.steps.splice(r.steps.indexOf(findStep(r, "phbftrFighter000", "UaSYMl2io5kbXNOY")), 1)],
    ["T6", "Fighter skill outside its list (Stealth)", CODES.NOT_ALLOWED,
      r => findStep(r, "phbftrFighter000", "UaSYMl2io5kbXNOY").data.chosen = ["skills:ani", "skills:ste"]]
  ]
};

/* -------------------------------------------- */
/*  Run                                         */
/* -------------------------------------------- */

export async function run({ rules = game.settings.get("dnd5e", "rulesVersion"), timingRuns = 10 } = {}) {
  const report = { spike: "1.3", rules, user: game.user.name, isGM: game.user.isGM, checks: [], errors: [] };
  const check = (id, name, pass, detail = {}) => report.checks.push({ id, name, ok: !!pass, ...detail });
  const stopWatch = watchDb();
  const initialsBefore = schemaInitials();

  try {
    const built = await buildCharacter(rules);
    const recipe = extractRecipe(built, rules);
    const json = JSON.stringify(recipe);
    const stored = JSON.parse(json);
    report.recipeBytes = json.length;
    report.recipeSteps = stored.steps.length;
    check("R0", "Recipe survives a JSON round trip unchanged", JSON.stringify(stored) === json);

    // R1/R2: replay from the stored recipe ≡ the interactive build, with no validation errors.
    const replayed = await replay(stored);
    const same = compare(snapshot(replayed.actor), snapshot(built.actor));
    check("R1", "Replay from the stored recipe ≡ the interactive build", same.equal, same);
    check("R2", "An untampered recipe passes validation", !replayed.errors.length, { errors: replayed.errors });

    // Tamper cases: each must be reported with the expected code.
    for ( const [id, name, code, mutate] of TAMPERS[rules] ) {
      const tampered = foundry.utils.deepClone(stored);
      try {
        mutate(tampered);
      } catch ( err ) {
        check(id, `${name} → ${code}`, false, { error: `could not build tamper case: ${err.message}` });
        continue;
      }
      const { errors } = await replay(tampered);
      check(id, `${name} → ${code}`, errors.some(e => e.code === code), { errors });
    }

    // Timing: full rebuild from the stored recipe (first run may load documents; the rest are warm).
    const times = [];
    for ( let i = 0; i < timingRuns; i++ ) {
      const t0 = performance.now();
      await replay(stored);
      times.push(Math.round(performance.now() - t0));
    }
    const sorted = [...times].sort((a, b) => a - b);
    report.timing = { runs: times, median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) };
    check("P1", `Full rebuild median ${report.timing.median} ms (< 1500 ms)`, report.timing.median < 1500, report.timing);
  } catch ( err ) {
    report.errors.push({ message: err.message, stack: err.stack?.split("\n").slice(0, 8).join("\n") });
  }

  report.dbWrites = stopWatch();
  const initialsAfter = schemaInitials();
  const mutated = Object.keys(initialsBefore).filter(k => initialsBefore[k] !== initialsAfter[k]);
  check("G1", "No schema default was mutated", !mutated.length, { mutated });
  report.tamperIds = TAMPERS[rules].map(t => t[0]);
  return report;
}

// Re-exported for tests that want to build their own cases.
export { PICKS, findFirst };

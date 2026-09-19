/**
 * One advancement step: what it offers (filtered by the catalog and dnd5e's own logic), what applies
 * automatically, and checks on the data before and after dnd5e's `apply()` (which validates nothing —
 * RESEARCH.md → Spike 1.3). Rules stay in dnd5e (convention 2): trait pools, prerequisites, points and
 * counts all come from the advancement and its data.
 */

import { makeError, ABILITIES } from "../contracts.mjs";
import { normalizeUuid } from "../catalog/filters.mjs";

/** The advancement types the wizard's widgets cover (dnd5e 5.3; RESEARCH.md → Spike 1.9). */
export const KNOWN_TYPES = Object.freeze(["AbilityScoreImprovement", "HitPoints", "ItemChoice", "ItemGrant", "ScaleValue",
  "Size", "Subclass", "Trait"]);

const norm = u => normalizeUuid(u);
const abilityOptions = config => [...(config.spell?.ability ?? [])];

/** Spells a spell ItemChoice with an empty pool offers: its lists (or every spell) at its level, in the catalog. */
function spellOptions(config, catalog) {
  const { restriction = {} } = config;
  const lists = [...(restriction.list ?? [])];
  const level = restriction.level === "" || restriction.level == null ? null : Number(restriction.level);
  let uuids;
  if ( lists.length ) {
    uuids = new Set();
    for ( const key of lists ) {
      const [type, id] = key.split(":");
      for ( const u of dnd5e.registry.spellLists.forType(type, id)?.uuids ?? [] ) uuids.add(norm(u));
    }
  }
  return catalog.byCategory.spell
    .filter(e => (level === null || e.system?.level === level) && (!uuids || uuids.has(norm(e.uuid))))
    .map(e => norm(e.uuid));
}

/**
 * What a step offers, for the widget and the checks. `null` for an ItemChoice with nothing to pick at
 * this level (no step).
 * @param {Advancement} adv
 * @param {number} level
 * @param {{ actor: Actor, catalog: object }} ctx
 */
export async function stepOptions(adv, level, { actor, catalog }) {
  const c = adv.configuration;
  switch ( adv.type ) {
    case "Trait": {
      const { available, choices } = await adv.unfulfilledChoices(new Set());
      const allowed = new Set(c.grants);
      for ( const a of available ) a.choices.asSet(allowed);
      // allowReplacements (2014 Acolyte): a granted trait already held may be replaced by any other of its type.
      if ( c.allowReplacements ) {
        choices.filter(adv.representedTraits().map(t => `${t}:*`), { inplace: false }).asSet(allowed);  // Set, as dnd5e passes it
      }
      return { type: "Trait", mode: c.mode, grants: [...c.grants], choices: c.choices.map(ch => ({ count: ch.count, pool: [...ch.pool] })),
        max: adv.maxTraits, allowed: [...allowed], replacements: !!c.allowReplacements };
    }
    case "ItemChoice": {
      const count = c.choices[level]?.count ?? 0;
      if ( !count ) return null;
      let options = c.pool.length ? c.pool.map(p => norm(p.uuid)).filter(u => catalog.get(u))
        : c.type === "spell" ? spellOptions(c, catalog) : [];
      // dnd5e's own prerequisites (level, required items, not repeatable) on the character as it is now.
      if ( c.type !== "spell" ) {
        const ok = [];
        for ( const u of options ) {
          const doc = await fromUuid(u);
          const valid = doc?.system?.validatePrerequisites?.(actor, { level: actor.system.details.level }) ?? true;
          if ( valid === true ) ok.push(u);
        }
        options = ok;
      }
      return { type: "ItemChoice", count, itemType: c.type, options, abilityOptions: abilityOptions(c) };
    }
    case "ItemGrant":
      return { type: "ItemGrant", items: (c.items ?? []).map(i => ({ uuid: norm(i.uuid), optional: !!(c.optional || i.optional) })),
        abilityOptions: abilityOptions(c) };
    case "AbilityScoreImprovement":
      return { type: "AbilityScoreImprovement",
        fixed: Object.fromEntries(Object.entries(c.fixed ?? {}).filter(([, v]) => v)), points: c.points ?? 0,
        cap: c.cap ?? null, locked: [...(c.locked ?? [])], improvable: ABILITIES.filter(k => adv.canImprove(k)) };
    case "Size":
      return { type: "Size", sizes: [...(c.sizes ?? [])] };
    case "Subclass": {
      const identifier = adv.item.identifier;
      return { type: "Subclass", options: catalog.byCategory.subclass
        .filter(e => e.system?.classIdentifier === identifier).map(e => norm(e.uuid)) };
    }
    case "HitPoints":
    case "ScaleValue":
      return { type: adv.type };
    default:
      return { type: adv.type, unknown: true };
  }
}

/**
 * Data to apply without asking the player, or null if the player must choose. Includes D4 auto-select
 * (a pool with exactly as many allowed options as picks).
 */
export async function automaticData(adv, level, opts) {
  switch ( adv.type ) {
    case "Trait":
    case "ItemGrant":
    case "HitPoints":
      return (await adv.automaticApplicationValue(level)) || null;
    case "ItemChoice":
      return opts.options.length === opts.count && opts.abilityOptions.length <= 1
        ? { selected: [...opts.options], ...(opts.abilityOptions[0] ? { ability: opts.abilityOptions[0] } : {}) } : null;
    case "AbilityScoreImprovement":
      return opts.points ? null : { type: "asi", assignments: { ...opts.fixed } };
    case "Size":
      // Not dnd5e's automaticApplicationValue: it reports a choice as automatic (RESEARCH.md → Spike 1.1).
      return opts.sizes.length === 1 ? { size: opts.sizes[0] } : null;
    case "Subclass":
      return opts.options.length === 1 ? { uuid: opts.options[0] } : null;
    case "ScaleValue":
      return {};
    default:
      return null;
  }
}

/** Checks on `data` before apply(). Returns makeError() objects. */
export function checkBefore(adv, level, data, opts) {
  const out = [];
  const fail = (code, detail) => out.push(makeError(code, detail));
  switch ( adv.type ) {
    case "Trait": {
      const chosen = data.chosen ?? [];
      if ( chosen.length > opts.max ) fail("TOO_MANY_PICKS", { chosen: chosen.length, max: opts.max });
      const allowed = new Set(opts.allowed);
      const bad = chosen.filter(k => !allowed.has(k));
      if ( bad.length ) fail("NOT_ALLOWED", bad);
      break;
    }
    case "ItemGrant": {
      const offered = new Set(opts.items.map(i => i.uuid));
      const selected = (data.selected ?? []).map(norm);
      const bad = selected.filter(u => !offered.has(u));
      if ( bad.length ) fail("NOT_OFFERED", bad);
      const missing = opts.items.filter(i => !i.optional && !selected.includes(i.uuid)).map(i => i.uuid);
      if ( missing.length ) fail("UNFULFILLED", missing);
      checkAbility(data, opts, fail);
      break;
    }
    case "ItemChoice": {
      const selected = (data.selected ?? []).map(norm);
      if ( selected.length > opts.count ) fail("TOO_MANY_PICKS", { selected: selected.length, max: opts.count });
      if ( selected.length < opts.count ) fail("UNFULFILLED", { selected: selected.length, needed: opts.count });
      const offered = new Set(opts.options);
      const bad = selected.filter(u => !offered.has(u));
      if ( bad.length ) fail("NOT_OFFERED", bad);
      checkAbility(data, opts, fail);
      break;
    }
    case "AbilityScoreImprovement": {
      if ( data.type !== "asi" ) {
        fail("NOT_ALLOWED", { type: data.type });
        break;
      }
      let free = 0;
      for ( const [abl, n] of Object.entries(data.assignments ?? {}) ) {
        if ( !ABILITIES.includes(abl) || !Number.isInteger(n) || n < 0 ) {
          fail("NOT_ALLOWED", { [abl]: n });
          continue;
        }
        const extra = n - (opts.fixed[abl] ?? 0);
        if ( extra > 0 && opts.locked.includes(abl) ) fail("ASI_LOCKED", abl);
        if ( opts.cap !== null && extra > opts.cap ) fail("ASI_OVER_LIMIT", { abl, n, cap: opts.cap });
        free += Math.max(0, extra);
      }
      if ( free > opts.points ) fail("ASI_OVER_LIMIT", { assigned: free, points: opts.points });
      const missingFixed = Object.entries(opts.fixed).filter(([k, v]) => (data.assignments?.[k] ?? 0) < v).map(([k]) => k);
      if ( missingFixed.length ) fail("UNFULFILLED", missingFixed);
      break;
    }
    case "Size":
      if ( !opts.sizes.includes(data.size) ) fail("NOT_ALLOWED", data.size ?? null);
      break;
    case "Subclass":
      if ( !opts.options.includes(norm(data.uuid)) ) fail("NOT_OFFERED", data.uuid ?? null);
      break;
    case "HitPoints":
      // Level 1 takes the maximum (DESIGN.md → Validation).
      if ( level === 1 && data?.[1] !== "max" ) fail("NOT_ALLOWED", data);
      break;
  }
  return out;
}

function checkAbility(data, opts, fail) {
  if ( opts.abilityOptions.length > 1 && !opts.abilityOptions.includes(data.ability) ) fail("UNFULFILLED", { ability: data.ability ?? null });
  else if ( data.ability && opts.abilityOptions.length && !opts.abilityOptions.includes(data.ability) ) fail("NOT_ALLOWED", { ability: data.ability });
}

/** Checks after apply(): anything dnd5e still considers unfulfilled. */
export async function checkAfter(adv) {
  const out = [];
  if ( adv?.type === "Trait" ) {
    const open = (await adv.unfulfilledChoices()).available.filter(a => a.choices.asSet().size > 0);
    if ( open.length ) out.push(makeError("UNFULFILLED", open.map(a => [...a.choices.asSet()].slice(0, 5))));
  }
  if ( adv?.type === "AbilityScoreImprovement" ) {
    const { assigned, total } = adv.points;
    if ( assigned > total ) out.push(makeError("ASI_OVER_LIMIT", { assigned, total }));
  }
  return out;
}

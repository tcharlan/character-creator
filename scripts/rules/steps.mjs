/**
 * One advancement step: what it offers (filtered by the catalog and dnd5e's own logic), what applies
 * automatically, and checks on the data before and after dnd5e's `apply()` (which validates nothing —
 * RESEARCH.md → Spike 1.3). Rules stay in dnd5e (convention 2): trait pools, prerequisites, points and
 * counts all come from the advancement and its data.
 */

import { makeError, ABILITIES, hitPointSlot } from "../contracts.mjs";
import { normalizeUuid } from "../catalog/filters.mjs";

/** The advancement types the wizard's widgets cover (dnd5e 5.3; RESEARCH.md → Spike 1.9). */
export const KNOWN_TYPES = Object.freeze(["AbilityScoreImprovement", "HitPoints", "ItemChoice", "ItemGrant", "ScaleValue",
  "Size", "Subclass", "Trait"]);

const norm = u => normalizeUuid(u);
const abilityOptions = config => [...(config.spell?.ability ?? [])];

/**
 * The highest spell level an item can cast: dnd5e's `ItemChoiceFlow#_maxSpellSlotLevel` (dnd5e.mjs 41350),
 * through the same public statics — for a class or subclass, that class's own slots, as if it were the only
 * one (so a multiclassed character's Magical Secrets counts only its Bard levels, and each class chooses its
 * spells "as if you were a single-classed member of that class", PHB multiclassing); otherwise the actor's.
 */
export function maxSpellLevelFor(item, actor = item.actor) {
  const spellcasting = item.spellcasting;
  let spells;
  if ( spellcasting?.type ) {
    const progression = Object.fromEntries(Object.keys(CONFIG.DND5E.spellcasting).map(k => [k, 0]));
    const maxSpellLevel = Object.keys(CONFIG.DND5E.spellLevels).length - 1;
    spells = Object.fromEntries(Array.fromRange(maxSpellLevel, 1).map(l => [`spell${l}`, {}]));
    CONFIG.Actor.documentClass.computeClassProgression(progression, item, { spellcasting });
    CONFIG.Actor.documentClass.prepareSpellcastingSlots(spells, spellcasting.type, progression, { actor });
  } else spells = actor?.system?.spells ?? {};
  return Object.values(spells).reduce((slot, { max, level }) => (max ? Math.max(slot, level || -1) : slot), 0);
}

/** The highest spell level an advancement's item can cast (see maxSpellLevelFor). */
export const maxSpellSlotLevel = adv => maxSpellLevelFor(adv.item, adv.actor);

/**
 * Spells a spell ItemChoice with an empty pool offers: its lists (or every spell) at its level, in the catalog.
 * The level is a number, or "available" — any level the item can cast (2014 Magical Secrets, Signature Spells).
 */
function spellOptions(config, catalog, adv) {
  const { restriction = {} } = config;
  const lists = [...(restriction.list ?? [])];
  const available = restriction.level === "available";
  const level = available || restriction.level === "" || restriction.level == null ? null : Number(restriction.level);
  const highest = available ? maxSpellSlotLevel(adv) : null;
  let uuids;
  if ( lists.length ) {
    uuids = new Set();
    for ( const key of lists ) {
      const [type, id] = key.split(":");
      for ( const u of dnd5e.registry.spellLists.forType(type, id)?.uuids ?? [] ) uuids.add(norm(u));
    }
  }
  return catalog.byCategory.spell
    .filter(e => (level === null || e.system?.level === level) && (highest === null || (e.system?.level ?? 99) <= highest)
      && (!uuids || uuids.has(norm(e.uuid))))
    .map(e => norm(e.uuid));
}

/**
 * What a step offers, for the widget and the checks. `null` for an ItemChoice with nothing to pick at
 * this level (no step).
 * @param {Advancement} adv
 * @param {number} level
 * @param {{ actor: Actor, catalog: object }} ctx
 */
export async function stepOptions(adv, level, { actor, catalog, hitPoints = null }) {
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
        : c.type === "spell" ? spellOptions(c, catalog, adv) : [];
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
    case "AbilityScoreImprovement": {
      // A feat in place of the increase (dnd5e `allowFeat`: a class's ASI under modern rules or the dnd5e
      // `allowFeats` setting) — only where there are points to spend: a fixed increase (2024 Monk's Body and
      // Mind) is not a feat slot (Spike 8.0).
      const allowFeat = !!adv.allowFeat && ((c.points ?? 0) > 0);
      return { type: "AbilityScoreImprovement",
        fixed: Object.fromEntries(Object.entries(c.fixed ?? {}).filter(([, v]) => v)), points: c.points ?? 0,
        cap: c.cap ?? null, locked: [...(c.locked ?? [])], improvable: ABILITIES.filter(k => adv.canImprove(k)),
        allowFeat, feats: allowFeat ? await eligibleFeats(actor, catalog) : [], epicBoon: !!adv.isEpicBoon,
        recommendation: c.recommendation ? norm(c.recommendation) : null,
        // The scores before this increase, and how high each may go (dnd5e's ability maximum, 20 by default).
        current: Object.fromEntries(ABILITIES.map(k => [k, actor.system.abilities?.[k]?.value ?? null])),
        maximum: Object.fromEntries(ABILITIES.map(k => [k, Math.max(actor.system.abilities?.[k]?.max ?? 20, c.max ?? 0)])) };
    }
    case "Size":
      return { type: "Size", sizes: [...(c.sizes ?? [])] };
    case "Subclass": {
      const identifier = adv.item.identifier;
      return { type: "Subclass", options: catalog.byCategory.subclass
        .filter(e => e.system?.classIdentifier === identifier).map(e => norm(e.uuid)) };
    }
    case "HitPoints":
      return { type: "HitPoints", method: hitPoints?.method ?? "average", expected: hitPointsData(adv, level, hitPoints ?? {}),
        slot: hitPointSlot(adv.item.identifier, level), faces: adv.hitDieValue ?? null };
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
      return (await adv.automaticApplicationValue(level)) || null;
    case "HitPoints":
      return opts.expected;
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
      if ( data.type === "feat" ) {
        if ( !opts.allowFeat ) fail("NOT_ALLOWED", { type: data.type });
        else if ( !opts.feats.includes(norm(data.uuid)) ) fail("NOT_OFFERED", data.uuid ?? null);
        break;
      }
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
      // The first class's first level takes the maximum; every other level what the GM's method gives (D33).
      if ( !opts.expected || (data?.[level] !== opts.expected[level]) ) fail("NOT_ALLOWED", data);
      break;
  }
  return out;
}

/**
 * Hit points for one class level (D33): the maximum at the first class's first level (dnd5e's own rule,
 * `HitPointsAdvancement#automaticApplicationValue`), otherwise the average, or the hit die rolled for that slot.
 * Null when the roll for it hasn't been made yet.
 */
export function hitPointsData(adv, level, { method = "average", rolls = {} } = {}) {
  if ( (level === 1) && adv.item.isOriginalClass ) return { [level]: "max" };
  if ( method !== "rolled" ) return { [level]: "avg" };
  const roll = rolls?.[hitPointSlot(adv.item.identifier, level)];
  return Number.isInteger(roll?.total) ? { [level]: roll.total } : null;
}

/**
 * The feats an ability score improvement can take instead, by dnd5e's own rule (D36; its ASI picker and
 * `validatePrerequisites`): every allowed feat whose prerequisites the character meets now — level, required
 * items, not already taken unless repeatable. Ability requirements are text in the feat and aren't checked,
 * as dnd5e doesn't (Spike 8.0).
 */
export async function eligibleFeats(actor, catalog) {
  const out = [];
  const level = actor.system.details?.level ?? 1;
  for ( const e of catalog.byCategory.feat ?? [] ) {
    if ( e.system?.type?.value !== "feat" ) continue;
    // Rules gap: an Epic Boon is a level-19 feat (2024 PHB, chapter 5, "Epic Boon Feats": "Prerequisite: Level
    // 19+"), but two of the SRD's carry no level prerequisite in dnd5e's data (Boon of Fate, Boon of Irresistible
    // Offense), so dnd5e's own check would offer them at level 4.
    if ( (e.system?.type?.subtype === "epicBoon") && (level < 19) ) continue;
    const doc = await fromUuid(e.uuid);
    if ( doc?.system?.validatePrerequisites?.(actor, { level: actor.system.details.level }) === true ) out.push(norm(e.uuid));
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

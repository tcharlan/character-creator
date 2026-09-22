/**
 * The Choices step (PLAN 3.4, D14): every choice the character's species, background and class offer at level 1,
 * grouped by the item that offers them, with one widget per advancement type.
 *
 * The options come from the rebuild (`buildCharacter(..., { withOptions: true })`); this turns them into what the
 * screen shows, and turns a click into the `data` an advancement's `apply()` wants (rules/steps.mjs).
 */

import { ABILITIES } from "../contracts.mjs";

/** Advancement types the player answers here. HitPoints and ScaleValue are shown read-only. */
export const CHOICE_TYPES = Object.freeze(["Trait", "ItemChoice", "ItemGrant", "AbilityScoreImprovement", "Size", "Subclass"]);
const READ_ONLY = Object.freeze(["HitPoints", "ScaleValue"]);

const label = key => globalThis.dnd5e?.documents?.Trait?.keyLabel?.(key) ?? key;
const sizeLabel = key => globalThis.CONFIG?.DND5E?.actorSizes?.[key]?.label ?? key;
const abilityLabel = key => globalThis.CONFIG?.DND5E?.abilities?.[key]?.label ?? key.toUpperCase();

/** An item's name and image from the catalog index (no documents loaded). */
function entry(catalog, uuid) {
  const e = catalog?.get?.(uuid);
  return { uuid, name: e?.name ?? uuid.split(".").pop(), img: e?.img ?? null };
}

/* -------------------------------------------- */
/*  Widgets                                     */
/* -------------------------------------------- */

/** Trait: a checklist of the keys this advancement allows, with the granted ones fixed. */
function traitWidget(result) {
  const { options, data } = result;
  const chosen = data?.chosen ?? [];
  const granted = new Set(options.grants ?? []);
  const needed = options.max ?? 0;
  const full = chosen.length >= needed;
  const list = (options.allowed ?? []).map(key => {
    // Already the character's and not the player's to change (no replacements): shown ticked and greyed.
    const given = granted.has(key) && chosen.includes(key) && !options.replacements;
    return { key, label: label(key), checked: chosen.includes(key), granted: granted.has(key), given,
      // Only the picks beyond the grants can be turned off, and nothing beyond the count can be turned on.
      disabled: given || (full && !chosen.includes(key)) };
  });
  // What the player picks themselves: the count leaves out what is already given ("0 / 2", not "1 / 3").
  const given = list.filter(o => o.given).length;
  return { type: "Trait", list, chosen: chosen.length, needed, replacements: !!options.replacements,
    picked: chosen.length - given, toPick: Math.max(0, needed - given) };
}

/** ItemChoice: pick `count` items (or spells) from the pool the GM allows. */
function itemChoiceWidget(result, catalog) {
  const { options, data } = result;
  const selected = data?.selected ?? [];
  const full = selected.length >= options.count;
  return {
    type: "ItemChoice",
    itemType: options.itemType,
    needed: options.count,
    chosen: selected.length,
    // Past the count the rest are out of reach rather than hidden, so the screen never shows an illegal pick.
    list: (options.options ?? []).map(uuid => ({ ...entry(catalog, uuid), selected: selected.includes(uuid),
      disabled: full && !selected.includes(uuid) })),
    ability: abilityWidget(options, data)
  };
}

/** ItemGrant: what comes with the item; optional entries can be turned down. */
function itemGrantWidget(result, catalog) {
  const { options, data } = result;
  const selected = data?.selected ?? [];
  return {
    type: "ItemGrant",
    list: (options.items ?? []).map(i => ({ ...entry(catalog, i.uuid), optional: i.optional, selected: selected.includes(i.uuid) })),
    ability: abilityWidget(options, data)
  };
}

/** The spellcasting ability an item grant or choice asks for (2024 lineage spells). */
function abilityWidget(options, data) {
  const choices = options.abilityOptions ?? [];
  if ( choices.length < 2 ) return null;
  return { chosen: data?.ability ?? null, list: choices.map(key => ({ key, label: abilityLabel(key), selected: data?.ability === key })) };
}

/** Ability score increases: fixed ones are shown, free points are spent here. */
function asiWidget(result) {
  const { options, data } = result;
  const assignments = data?.assignments ?? { ...options.fixed };
  const spent = ABILITIES.reduce((n, key) => n + Math.max(0, (assignments[key] ?? 0) - (options.fixed[key] ?? 0)), 0);
  const left = (options.points ?? 0) - spent;
  return {
    type: "AbilityScoreImprovement",
    points: options.points ?? 0,
    left,
    cap: options.cap,
    rows: ABILITIES.map(key => {
      const fixed = options.fixed[key] ?? 0;
      const value = assignments[key] ?? fixed;
      const free = value - fixed;
      const locked = (options.locked ?? []).includes(key) || !(options.improvable ?? []).includes(key);
      return {
        key, label: abilityLabel(key), fixed, value, free, locked,
        canRaise: !locked && (left > 0) && ((options.cap === null) || (free < options.cap)),
        canLower: !locked && (free > 0)
      };
    })
  };
}

/** Size: one of the sizes the species allows. */
function sizeWidget(result) {
  const chosen = result.data?.size ?? null;
  return { type: "Size", list: (result.options.sizes ?? []).map(key => ({ key, label: sizeLabel(key), selected: key === chosen })) };
}

/** Subclass: the subclasses of this class the GM allows. */
function subclassWidget(result, catalog) {
  const chosen = result.data?.uuid ?? null;
  return { type: "Subclass", list: (result.options.options ?? []).map(uuid => ({ ...entry(catalog, uuid), selected: uuid === chosen })) };
}

/* -------------------------------------------- */
/*  The step                                    */
/* -------------------------------------------- */

/**
 * The Choices step: the build's steps grouped by the item that offers them.
 * @param {object} built                 From buildCharacter({ withOptions: true }).
 * @param {object} catalog
 * @param {string|null} [openKey]        The choice being answered (defaults to the first that needs input).
 * @returns {{ groups, open, counts }}
 */
export function choicesModel(built, catalog, openKey = null) {
  const results = (built?.results ?? []).filter(r => !READ_ONLY.includes(r.type) || r.status === "invalid");
  const choices = results.map(r => {
    const widget = r.options && CHOICE_TYPES.includes(r.type) ? buildWidget(r, catalog) : null;
    return {
      key: r.key, path: r.path, advancementId: r.advancementId, level: r.level, type: r.type, title: r.title,
      item: r.item, status: r.status, widget,
      errors: (r.errors ?? []).map(e => e.key),
      automatic: r.status === "auto",
      needsInput: r.status === "needsInput",
      // "blocked" is an advancement this module has no widget for (homebrew, PLAN 5.1): it needs attention
      // just as much as a broken answer, and the player is told which item it came from.
      invalid: (r.status === "invalid") || (r.status === "blocked")
    };
  });

  const open = choices.find(c => c.key === openKey) ?? choices.find(c => c.needsInput || c.invalid) ?? choices[0] ?? null;
  const groups = [];
  for ( const choice of choices ) {
    const group = groups.find(g => g.item === choice.item) ?? groups[groups.push({ item: choice.item, choices: [] }) - 1];
    group.choices.push({ ...choice, open: choice.key === open?.key });
  }
  return {
    groups,
    open: open ? { ...open, open: true } : null,
    counts: {
      total: choices.length,
      open: choices.filter(c => c.needsInput).length,
      invalid: choices.filter(c => c.invalid).length,
      done: choices.filter(c => !c.needsInput && !c.invalid).length
    }
  };
}

/**
 * Whether a choice is answered, worked out from the answer itself rather than from a replay (PLAN 3.11). The
 * replay is still what decides in the end; this only keeps the screen honest while the player is clicking.
 * @returns {"done"|"needsInput"}
 */
export function localStatus(result, data) {
  const o = result?.options ?? {};
  const ability = !(o.abilityOptions?.length > 1) || !!data?.ability;
  switch ( result?.type ) {
    case "Trait": return ((data?.chosen?.length ?? 0) >= (o.max ?? 0)) ? "done" : "needsInput";
    case "ItemChoice": return (((data?.selected?.length ?? 0) >= (o.count ?? 0)) && ability) ? "done" : "needsInput";
    case "ItemGrant": return ability ? "done" : "needsInput";
    case "AbilityScoreImprovement": {
      const assignments = data?.assignments ?? {};
      const fixed = o.fixed ?? {};
      const spent = Object.keys({ ...fixed, ...assignments })
        .reduce((n, key) => n + Math.max(0, (assignments[key] ?? 0) - (fixed[key] ?? 0)), 0);
      return spent >= (o.points ?? 0) ? "done" : "needsInput";
    }
    case "Size": return data?.size ? "done" : "needsInput";
    case "Subclass": return data?.uuid ? "done" : "needsInput";
    default: return result?.status ?? "needsInput";
  }
}

/**
 * The last build with one answer written into it, for the screen only: replaying the character takes a
 * noticeable moment, so a click shows its result straight away and the replay happens when the player moves
 * on to another choice or leaves the step.
 */
export function withAnswer(built, key, data) {
  if ( !built ) return built;
  return { ...built, results: built.results.map(r => (r.key === key
    ? { ...r, data, status: localStatus(r, data), errors: [] } : r)) };
}

/**
 * The choice to walk to next: the first one after `currentKey` that still needs an answer, wrapping round to
 * the ones before it. Null when nothing is left open.
 * @param {ReturnType<choicesModel>} model
 * @param {string|null} currentKey
 */
export function nextOpenChoice(model, currentKey = null) {
  const all = (model?.groups ?? []).flatMap(g => g.choices);
  const at = all.findIndex(c => c.key === currentKey);
  const order = at < 0 ? all : [...all.slice(at + 1), ...all.slice(0, at)];
  return order.find(c => c.needsInput || c.invalid)?.key ?? null;
}

function buildWidget(result, catalog) {
  switch ( result.type ) {
    case "Trait": return traitWidget(result);
    case "ItemChoice": return itemChoiceWidget(result, catalog);
    case "ItemGrant": return itemGrantWidget(result, catalog);
    case "AbilityScoreImprovement": return asiWidget(result);
    case "Size": return sizeWidget(result);
    case "Subclass": return subclassWidget(result, catalog);
    default: return null;
  }
}

/* -------------------------------------------- */
/*  Answers                                     */
/* -------------------------------------------- */

/**
 * The data for a choice after the player clicked something. Returns null when the click changes nothing (for
 * example a trait already granted, or one pick too many).
 * @param {object} result                The build result for this choice (options and current data).
 * @param {{ action: string, value?: string }} click
 */
export function answerData(result, click) {
  const { options, data, type } = result;
  switch ( type ) {
    case "Trait": {
      const chosen = [...(data?.chosen ?? [])];
      const key = click.value;
      if ( !(options.allowed ?? []).includes(key) ) return null;
      const at = chosen.indexOf(key);
      if ( at >= 0 ) {
        if ( (options.grants ?? []).includes(key) && !options.replacements ) return null;   // granted, not a choice
        chosen.splice(at, 1);
      } else {
        if ( chosen.length >= (options.max ?? 0) ) return null;
        chosen.push(key);
      }
      return { chosen };
    }
    case "ItemChoice": {
      const selected = [...(data?.selected ?? [])];
      if ( click.action === "ability" ) return { selected, ability: click.value };
      const at = selected.indexOf(click.value);
      if ( at >= 0 ) selected.splice(at, 1);
      else {
        if ( selected.length >= options.count ) return null;
        selected.push(click.value);
      }
      return { selected, ...(data?.ability ? { ability: data.ability } : {}) };
    }
    case "ItemGrant": {
      const required = (options.items ?? []).filter(i => !i.optional).map(i => i.uuid);
      const selected = new Set([...(data?.selected ?? []), ...required]);
      if ( click.action === "ability" ) return { selected: [...selected], ability: click.value };
      const item = (options.items ?? []).find(i => i.uuid === click.value);
      if ( !item?.optional ) return null;
      if ( selected.has(click.value) ) selected.delete(click.value);
      else selected.add(click.value);
      return { selected: [...selected], ...(data?.ability ? { ability: data.ability } : {}) };
    }
    case "AbilityScoreImprovement": {
      const assignments = { ...(data?.assignments ?? options.fixed) };
      const key = click.value;
      const fixed = options.fixed[key] ?? 0;
      const delta = click.action === "raise" ? 1 : -1;
      const next = (assignments[key] ?? fixed) + delta;
      if ( next < fixed ) return null;
      if ( (options.cap !== null) && ((next - fixed) > options.cap) ) return null;
      const spent = ABILITIES.reduce((n, a) => n + Math.max(0, ((a === key ? next : assignments[a] ?? 0)) - (options.fixed[a] ?? 0)), 0);
      if ( spent > (options.points ?? 0) ) return null;
      assignments[key] = next;
      return { type: "asi", assignments };
    }
    case "Size":
      return (options.sizes ?? []).includes(click.value) ? { size: click.value } : null;
    case "Subclass":
      return (options.options ?? []).includes(click.value) ? { uuid: click.value } : null;
    default:
      return null;
  }
}

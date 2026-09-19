/*
 * SPIKE helpers — throwaway, shared by spike 1.2+ (1.1 stays standalone as recorded).
 * Not part of the module.
 */

export const PICKS = {
  legacy: {
    species: [["dnd5e.races", "Hill Dwarf", "race"]],
    background: [["dnd5e.backgrounds", "Acolyte", "background"]],
    class: [["dnd5e.classes", "Cleric", "class"]],
    subclassPacks: ["dnd5e.subclasses"]
  },
  modern: {
    species: [["dnd5e.origins24", "Human", "race"]],
    background: [["dnd5e.origins24", "Sage", "background"]],
    class: [["dnd5e.classes24", "Fighter", "class"]],
    subclassPacks: ["dnd5e.classes24"]
  }
};

export const BASE_SCORES = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };

/* -------------------------------------------- */
/*  Database watch                              */
/* -------------------------------------------- */

/** Start recording every client-side database write. Returns `stop()` → list of writes. */
export function watchDb() {
  const writes = [];
  const ids = [];
  for ( const doc of ["Actor", "Item", "User", "ActiveEffect", "ChatMessage"] ) {
    for ( const op of ["preCreate", "preUpdate", "preDelete"] ) {
      const hook = `${op}${doc}`;
      ids.push([hook, Hooks.on(hook, d => writes.push({ hook, name: d?.name ?? null }))]);
    }
  }
  const actorsBefore = game.actors.size;
  return () => {
    for ( const [hook, id] of ids ) Hooks.off(hook, id);
    if ( game.actors.size !== actorsBefore ) writes.push({ hook: "game.actors.size changed" });
    return writes;
  };
}

/* -------------------------------------------- */
/*  Building                                    */
/* -------------------------------------------- */

export async function findFirst(candidates) {
  for ( const [packId, name, type] of candidates ) {
    const pack = game.packs.get(packId);
    if ( !pack ) continue;
    const index = await pack.getIndex({ fields: ["type"] });
    const entry = index.find(e => e.name === name && e.type === type);
    if ( entry ) return pack.getDocument(entry._id);
  }
  return null;
}

export function makeActor(base = BASE_SCORES) {
  const abilities = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { value: v }]));
  // A default-constructed actor shares some arrays with the schema's `initial` values (dnd5e trait
  // SetFields use one `[]` literal; Foundry returns non-function initials uncloned; ArrayField
  // updates arrays in place). Round-trip through toObject() so this actor owns fresh copies.
  const seed = new Actor.implementation({
    type: "character", name: "Spike scratch",
    ownership: { default: 0, [game.user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
    system: { abilities }
  });
  return new Actor.implementation(seed.toObject());
}

/**
 * JSON of every non-function object/array `initial` in the Actor and Item type schemas, so a run
 * can prove it never mutated a shared default.
 */
export function schemaInitials() {
  const out = {};
  const walk = (field, path, seen) => {
    if ( !field || seen.has(field) ) return;
    seen.add(field);
    const init = field.initial;
    if ( init && typeof init === "object" ) out[path] = JSON.stringify(init);
    for ( const [k, f] of Object.entries(field.fields ?? {}) ) walk(f, `${path}.${k}`, seen);
    if ( field.element ) walk(field.element, `${path}[]`, seen);
    if ( field.model?.schema ) walk(field.model.schema, path, seen);
  };
  for ( const [doc, models] of [["Actor", CONFIG.Actor.dataModels], ["Item", CONFIG.Item.dataModels]] ) {
    for ( const [type, model] of Object.entries(models ?? {}) ) walk(model.schema, `${doc}.${type}`, new Set());
  }
  return out;
}

export function embed(actor, doc, overrides = {}) {
  const data = game.items.fromCompendium(doc);
  data._id = foundry.utils.randomID();
  for ( const [path, value] of Object.entries(overrides) ) foundry.utils.setProperty(data, path, value);
  actor.updateSource({ items: [data] });
  return actor.items.get(data._id);
}

export const getAdv = (actor, itemId, advId) => actor.items.get(itemId)?.advancement.byId[advId];

/**
 * Build a full level-1 character the 1.1 way.
 * @param {string} rules                      "legacy" | "modern"
 * @param {object} [opts]
 * @param {object} [opts.overrides]           `"<item name>/<advancement title>"` → data for apply
 * @param {object} [opts.base]                base ability scores
 * @param {boolean} [opts.skipSubclass]       stop before the Subclass advancement
 * @returns {Promise<{actor, steps, ids}>}    `ids`: role → item id; steps: one per advancement applied
 */
export async function buildCharacter(rules, { overrides = {}, base = BASE_SCORES, skipSubclass = false } = {}) {
  const picks = PICKS[rules];
  const actor = makeActor(base);
  const ids = {};
  const species = embed(actor, await findFirst(picks.species));
  const background = embed(actor, await findFirst(picks.background));
  const cls = embed(actor, await findFirst(picks.class), { "system.levels": 1 });
  actor.updateSource({ "system.details.originalClass": cls.id });
  actor.reset();
  Object.assign(ids, { species: species.id, background: background.id, class: cls.id });

  const ctx = { actor, rules, picks, overrides, skipSubclass, steps: [], done: new Set() };
  await processItem(ctx, species.id, [0, 1], "species");
  await processItem(ctx, background.id, [0, 1], "background");
  await processItem(ctx, cls.id, [1], "class");
  const subclass = actor.items.find(i => i.type === "subclass");
  if ( subclass ) {
    ids.subclass = subclass.id;
    await processItem(ctx, subclass.id, [1], "subclass");
  }
  await processGranted(ctx);
  actor.reset();
  return { actor, steps: ctx.steps, ids };
}

/** Apply advancements of items that were granted and have their own (e.g. Magic Initiate). */
export async function processGranted(ctx) {
  for ( let pass = 0; pass < 5; pass++ ) {
    const pending = ctx.actor.items.filter(i => !ctx.done.has(i.id) && Object.values(i.advancement?.byLevel ?? {})
      .some(a => a.length));
    if ( !pending.length ) return;
    for ( const item of pending ) await processItem(ctx, item.id, [0, 1], `granted:${item.name}`);
  }
}

export async function processItem(ctx, itemId, levels, source) {
  ctx.done.add(itemId);
  for ( const level of levels ) {
    const item = ctx.actor.items.get(itemId);
    const advs = (item?.advancement?.byLevel?.[level] ?? []).filter(a => a.appliesToClass);
    for ( const { id } of advs ) {
      const adv = getAdv(ctx.actor, itemId, id);
      if ( ctx.skipSubclass && adv.type === "Subclass" ) continue;
      const key = `${item.name}/${adv.title}`;
      const step = { source, key, itemId, advancementId: id, type: adv.type, level };
      if ( adv.type === "Trait" ) {
        const { choices } = await adv.unfulfilledChoices();
        step.offered = [...choices.asSet()];
      }
      const data = key in ctx.overrides ? ctx.overrides[key] : await buildData(ctx, adv, level, step);
      if ( data === undefined ) continue;
      step.data = foundry.utils.deepClone(data);
      try {
        await adv.apply(level, data);
      } catch ( err ) {
        step.error = err.message;
      }
      ctx.actor.reset();
      ctx.steps.push(step);
    }
  }
}

/** Hand-built `data` per advancement type (same rules as spike 1.1). */
export async function buildData(ctx, adv, level, step) {
  const config = adv.configuration;
  switch ( adv.type ) {
    case "Trait": {
      const chosen = new Set();
      for ( let i = 0; i < 30; i++ ) {
        const { available } = await adv.unfulfilledChoices(chosen);
        if ( !available.length ) break;
        const option = [...available[0].choices.asSet()].find(k => !chosen.has(k));
        if ( !option ) {
          step.note = "unfulfilled choice with no remaining options";
          break;
        }
        chosen.add(option);
      }
      return { chosen: [...chosen] };
    }
    case "ItemGrant":
      return {
        selected: (config.items ?? []).filter(i => !config.optional || !i.optional).map(i => i.uuid),
        ability: config.spell?.ability?.first?.()
      };
    case "ItemChoice": {
      const count = config.choices[level]?.count ?? 0;
      if ( !count ) return undefined;
      let uuids = config.pool.map(p => p.uuid);
      if ( uuids.length < count ) uuids = await spellListUuids(config);
      const held = new Set(ctx.actor.items.map(i => normalizeUuid(i._stats?.compendiumSource)).filter(Boolean));
      return {
        selected: uuids.filter(u => !held.has(normalizeUuid(u))).slice(0, count),
        ability: config.spell?.ability?.first?.()
      };
    }
    case "AbilityScoreImprovement": {
      const assignments = {};
      for ( const [k, v] of Object.entries(config.fixed ?? {}) ) if ( v ) assignments[k] = v;
      let points = config.points ?? 0;
      for ( const k of Object.keys(CONFIG.DND5E.abilities) ) {
        if ( points <= 0 ) break;
        if ( config.locked?.has?.(k) || !adv.canImprove(k) || assignments[k] ) continue;
        const add = Math.min(config.cap ?? 2, points);
        assignments[k] = add;
        points -= add;
      }
      return { type: "asi", assignments };
    }
    case "Size":
      return { size: config.sizes?.first?.() ?? "med" };
    case "Subclass": {
      for ( const packId of ctx.picks.subclassPacks ) {
        const index = await game.packs.get(packId)?.getIndex({ fields: ["type", "system.classIdentifier"] });
        const entry = index?.find(e => e.type === "subclass" && e.system?.classIdentifier === adv.item.identifier);
        if ( entry ) return { uuid: entry.uuid };
      }
      return undefined;
    }
    case "HitPoints":
      return { [level]: "max" };
    case "ScaleValue":
      return {};
    default:
      step.note = "UNKNOWN advancement type";
      return undefined;
  }
}

async function spellListUuids(config) {
  const { restriction = {} } = config;
  let uuids = [];
  for ( const key of restriction.list ?? [] ) {
    const [type, id] = key.split(":");
    const list = dnd5e.registry.spellLists.forType(type, id);
    if ( list ) uuids.push(...list.uuids);
  }
  uuids = [...new Set(uuids)];
  if ( restriction.level !== "" && restriction.level != null ) {
    const levels = await Promise.all(uuids.map(async u => (await fromUuid(u))?.system.level));
    uuids = uuids.filter((u, i) => levels[i] === Number(restriction.level));
  }
  return uuids;
}

/* -------------------------------------------- */
/*  Reversal                                    */
/* -------------------------------------------- */

/** Reverse one advancement (naive: just that advancement). */
export async function reverseOne(actor, itemId, advId, level) {
  const result = await getAdv(actor, itemId, advId).reverse(level);
  actor.reset();
  return result;
}

/**
 * Reverse one advancement and, first, everything that depends on it: advancements of items it
 * added (recursively), in reverse order of application.
 */
export async function reverseCascade(actor, steps, itemId, advId, level) {
  const dependents = [];
  const collect = (iId, aId) => {
    const adv = getAdv(actor, iId, aId);
    const addedIds = new Set(itemsAddedBy(actor, iId, aId, adv));
    for ( const step of steps ) {
      if ( addedIds.has(step.itemId) && !dependents.includes(step) ) {
        collect(step.itemId, step.advancementId);
        dependents.push(step);
      }
    }
  };
  collect(itemId, advId);
  for ( const step of [...dependents].reverse() ) {
    if ( actor.items.get(step.itemId) ) await reverseOne(actor, step.itemId, step.advancementId, step.level);
  }
  return reverseOne(actor, itemId, advId, level);
}

/** Ids of items an advancement put on the actor (grants, choices, subclass). */
export function itemsAddedBy(actor, itemId, advId, adv = getAdv(actor, itemId, advId)) {
  if ( !adv ) return [];
  if ( adv.type === "Subclass" ) {
    const doc = adv.value?.document;
    const id = typeof doc === "string" ? doc : doc?.id;
    return id ? [id] : [];
  }
  return actor.items.filter(i => i.flags?.dnd5e?.advancementOrigin === `${itemId}.${advId}`).map(i => i.id);
}

/** Items whose granting advancement or parent item is gone. */
export function orphans(actor) {
  const out = [];
  for ( const item of actor.items ) {
    const origin = item.flags?.dnd5e?.advancementOrigin;
    if ( origin ) {
      const [pid, aid] = origin.split(".");
      const parent = actor.items.get(pid);
      const adv = parent?.advancement.byId[aid];
      if ( !parent || !adv || !JSON.stringify(adv.toObject().value ?? {}).includes(item.id) ) {
        out.push({ name: item.name, reason: parent ? "advancement no longer lists it" : "parent item gone" });
      }
    }
    if ( item.type === "subclass" && !actor.items.find(i => i.type === "class"
      && i.identifier === item.system.classIdentifier) ) out.push({ name: item.name, reason: "no class" });
  }
  return out;
}

/* -------------------------------------------- */
/*  Comparison                                  */
/* -------------------------------------------- */

/** Canonical `Compendium.<pkg>.<pack>.Item.<id>` form (1.1: configs may omit the `Item.` segment). */
export function normalizeUuid(uuid) {
  if ( typeof uuid !== "string" ) return uuid;
  const m = uuid.match(/^Compendium\.([^.]+)\.([^.]+)\.(?:Item\.)?([A-Za-z0-9]{16})$/);
  return m ? `Compendium.${m[1]}.${m[2]}.Item.${m[3]}` : uuid;
}

/**
 * Id-independent snapshot of an actor: its system source, and each item (sorted) with its source
 * UUID, its origin and its advancement values, where every embedded item id is replaced by a stable
 * label (the item's source UUID, or name).
 */
export function snapshot(actor) {
  const label = new Map(actor.items.map(i => [i.id, `@${normalizeUuid(i._stats?.compendiumSource) ?? i.name}`]));
  const swap = value => {
    if ( typeof value === "string" ) {
      if ( label.has(value) ) return label.get(value);
      const swapped = value.includes(".") ? value.split(".").map(p => label.get(p) ?? p).join(".") : value;
      return normalizeUuid(swapped);
    }
    if ( Array.isArray(value) ) return value.map(swap);
    if ( value && typeof value === "object" ) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [label.get(k) ?? normalizeUuid(k), swap(v)]));
    }
    return value;
  };
  const source = actor.toObject();
  const items = source.items.map(i => ({
    name: i.name, type: i.type,
    src: normalizeUuid(i._stats?.compendiumSource) ?? null,
    origin: swap(i.flags?.dnd5e?.advancementOrigin ?? null),
    // Stored as an object keyed by advancement id in dnd5e 5.x (older data: an array).
    advancement: swap(Object.fromEntries(Object.values(i.system.advancement ?? {}).map(a => [a._id, a.value ?? null])))
  })).sort((a, b) => `${a.src}${a.name}${a.origin}`.localeCompare(`${b.src}${b.name}${b.origin}`));
  return { system: swap(source.system), items };
}

/**
 * Compare two snapshots. `differences` are real; `residue` are paths where one side is empty
 * (null / undefined / {} / []) and the other missing or empty too — left behind by reverse(), harmless.
 */
export function compare(a, b) {
  const fa = foundry.utils.flattenObject(JSON.parse(JSON.stringify(a)));
  const fb = foundry.utils.flattenObject(JSON.parse(JSON.stringify(b)));
  const isEmpty = v => v == null || (typeof v === "object" && !Object.keys(v).length);
  const differences = [];
  const residue = [];
  for ( const key of new Set([...Object.keys(fa), ...Object.keys(fb)]) ) {
    if ( JSON.stringify(fa[key]) === JSON.stringify(fb[key]) ) continue;
    if ( isEmpty(fa[key]) && isEmpty(fb[key]) ) residue.push([key, fa[key] ?? "(missing)", fb[key] ?? "(missing)"]);
    else differences.push([key, fa[key], fb[key]]);
  }
  return { equal: !differences.length, differences: differences.slice(0, 40), residue: residue.slice(0, 20) };
}

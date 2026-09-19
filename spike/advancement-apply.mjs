/*
 * SPIKE 1.1 — throwaway. Not part of the module (not listed in module.json).
 *
 * Question: can a Player-role user build an unsaved scratch actor and drive every dnd5e advancement
 * type directly with `advancement.apply(level, data)`, with nothing reaching the database?
 *
 * Run in the browser console as Player A in legacy-test or modern-test:
 *   const spike = await import("/modules/character-creator/spike/advancement-apply.mjs");
 *   const report = await spike.run();
 *   copy(JSON.stringify(report, null, 2));   // then paste the report back
 *
 * Choices are made the simplest legal way (first N allowed options) — the point is the data shapes
 * and the mechanics, not a good character.
 */

const ADVANCEMENT_TYPES = ["AbilityScoreImprovement", "HitPoints", "ItemChoice", "ItemGrant", "ScaleValue",
  "Size", "Subclass", "Trait"];

/** Items used per rule set: [pack, name, type]; the first match wins. */
const PICKS = {
  legacy: {
    species: [["dnd5e.races", "Hill Dwarf", "race"], ["dnd5e.races", "Dwarf", "race"]],
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

const BASE_SCORES = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };

/* -------------------------------------------- */

export async function run({ rules = game.settings.get("dnd5e", "rulesVersion") } = {}) {
  const picks = PICKS[rules];
  const report = {
    spike: "1.1", rules, user: game.user.name, role: game.user.role, isGM: game.user.isGM,
    dnd5e: game.system.version, foundry: game.version, started: new Date().toISOString(),
    picks: {}, steps: [], dbWrites: [], errors: [], typesSeen: [], typesMissing: [], final: null
  };

  // Watch for anything that would write to the database.
  const hookIds = [];
  for ( const doc of ["Actor", "Item", "User", "ActiveEffect", "ChatMessage"] ) {
    for ( const op of ["preCreate", "preUpdate", "preDelete"] ) {
      const hook = `${op}${doc}`;
      hookIds.push([hook, Hooks.on(hook, document => {
        report.dbWrites.push({ hook, name: document?.name ?? null, parent: document?.parent?.name ?? null });
      })]);
    }
  }
  const actorsBefore = game.actors.size;

  try {
    // 1. Scratch actor — constructed, never saved.
    const abilities = Object.fromEntries(Object.entries(BASE_SCORES).map(([k, v]) => [k, { value: v }]));
    // Built from a toObject() copy so it never shares arrays with schema defaults (spike 1.2 finding).
    const seed = new Actor.implementation({
      type: "character", name: "Spike scratch",
      ownership: { default: 0, [game.user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
      system: { abilities }
    });
    const actor = new Actor.implementation(seed.toObject());
    report.scratch = { id: actor.id, inCollection: game.actors.has(actor.id), isEmbedded: actor.isEmbedded };

    // 2. Embed the picked items in order: species, background, class (at level 1, original class).
    const species = await embed(actor, await findFirst(picks.species), report, "species");
    const background = await embed(actor, await findFirst(picks.background), report, "background");
    const cls = await embed(actor, await findFirst(picks.class), report, "class", { "system.levels": 1 });
    if ( cls ) actor.updateSource({ "system.details.originalClass": cls.id });
    actor.reset();

    // 3. Apply advancements: species and background at character levels 0–1, class at class level 1,
    //    then the subclass (if the class granted one), then anything granted that has its own advancements.
    const ctx = { actor, report, rules, picks, done: new Set() };
    if ( species ) await processItem(ctx, species.id, [0, 1], "species");
    if ( background ) await processItem(ctx, background.id, [0, 1], "background");
    if ( cls ) await processItem(ctx, cls.id, [1], "class");
    const subclass = actor.items.find(i => i.type === "subclass");
    if ( subclass ) await processItem(ctx, subclass.id, [1], "subclass");
    for ( let pass = 0; pass < 5; pass++ ) {
      const pending = actor.items.filter(i => !ctx.done.has(i.id) && i.advancement?.byLevel
        && Object.values(i.advancement.byLevel).some(a => a.length));
      if ( !pending.length ) break;
      for ( const item of pending ) await processItem(ctx, item.id, [0, 1], `granted:${item.name}`);
    }

    // 4. Summary of the scratch actor after everything applied.
    actor.reset();
    const sys = actor.system;
    report.final = {
      level: sys.details.level,
      hp: { value: sys.attributes.hp.value, max: sys.attributes.hp.max },
      abilities: Object.fromEntries(Object.entries(sys.abilities).map(([k, a]) => [k, a.value])),
      size: sys.traits.size,
      skills: Object.entries(sys.skills).filter(([, s]) => s.value > 0).map(([k, s]) => `${k}:${s.value}`),
      saves: Object.entries(sys.abilities).filter(([, a]) => a.proficient).map(([k]) => k),
      languages: [...(sys.traits.languages?.value ?? [])],
      weaponProf: [...(sys.traits.weaponProf?.value ?? [])],
      mastery: [...(sys.traits.weaponProf?.mastery?.value ?? [])],
      armorProf: [...(sys.traits.armorProf?.value ?? [])],
      tools: Object.keys(sys.tools ?? {}),
      items: actor.items.map(i => `${i.type}: ${i.name}`),
      stillUnsaved: !game.actors.has(actor.id)
    };
    report.recipe = report.steps.filter(s => s.data !== undefined)
      .map(({ source, item, advancementId, type, level, data }) => ({ source, item, advancementId, type, level, data }));
  } catch ( err ) {
    report.errors.push({ where: "run", message: err.message, stack: err.stack });
  } finally {
    for ( const [hook, id] of hookIds ) Hooks.off(hook, id);
  }

  report.actorsUnchanged = game.actors.size === actorsBefore;
  report.typesSeen = [...new Set(report.steps.map(s => s.type))].sort();
  report.typesMissing = ADVANCEMENT_TYPES.filter(t => !report.typesSeen.includes(t));
  report.verdict = {
    noDbWrites: report.dbWrites.length === 0 && report.actorsUnchanged,
    allApplied: report.steps.every(s => !s.error),
    allTypesCovered: report.typesMissing.length === 0
  };
  console.log("SPIKE 1.1 verdict", report.verdict);
  console.table(report.steps.map(s => ({ source: s.source, type: s.type, level: s.level, title: s.title,
    ok: !s.error, changed: s.changedPaths?.length ?? 0, added: s.itemsAdded?.length ?? 0 })));
  return report;
}

/* -------------------------------------------- */

async function findFirst(candidates) {
  for ( const [packId, name, type] of candidates ) {
    const pack = game.packs.get(packId);
    if ( !pack ) continue;
    const index = await pack.getIndex({ fields: ["type"] });
    const entry = index.find(e => e.name === name && e.type === type);
    if ( entry ) return pack.getDocument(entry._id);
  }
  return null;
}

async function embed(actor, doc, report, role, overrides = {}) {
  if ( !doc ) {
    report.errors.push({ where: `embed ${role}`, message: "item not found" });
    return null;
  }
  const data = game.items.fromCompendium(doc);
  data._id = foundry.utils.randomID();
  for ( const [path, value] of Object.entries(overrides) ) foundry.utils.setProperty(data, path, value);
  actor.updateSource({ items: [data] });
  report.picks[role] = { name: doc.name, uuid: doc.uuid, rules: doc.system.source?.rules ?? null,
    advancements: doc.system.advancement?.map?.(a => `${a.type}@${a.level ?? "?"}`) ?? null };
  return actor.items.get(data._id);
}

/* -------------------------------------------- */

async function processItem(ctx, itemId, levels, source) {
  ctx.done.add(itemId);
  for ( const level of levels ) {
    const item = ctx.actor.items.get(itemId);
    const advancements = (item?.advancement?.byLevel?.[level] ?? []).filter(a => a.appliesToClass);
    for ( const { id } of advancements ) await applyOne(ctx, itemId, id, level, source);
  }
}

async function applyOne(ctx, itemId, advancementId, level, source) {
  const { actor, report } = ctx;
  const getAdv = () => actor.items.get(itemId)?.advancement.byId[advancementId];
  let adv = getAdv();
  const step = { source, item: actor.items.get(itemId)?.name, advancementId, type: adv.type,
    level, title: adv.title, configuration: safe(adv.configuration) };
  report.steps.push(step);

  try {
    step.automatic = safe(await adv.automaticApplicationValue(level));
  } catch ( err ) {
    step.automaticError = err.message;
  }

  try {
    const data = await buildData(ctx, adv, level, step);
    if ( data === undefined ) return;
    step.data = safe(data);

    const before = actor.toObject();
    adv = getAdv();
    await adv.apply(level, data);
    actor.reset();
    const after = actor.toObject();

    const diff = foundry.utils.diffObject(before.system, after.system);
    step.changedPaths = Object.keys(foundry.utils.flattenObject(diff));
    step.changes = diff;
    const beforeIds = new Set(before.items.map(i => i._id));
    step.itemsAdded = after.items.filter(i => !beforeIds.has(i._id)).map(i => ({
      name: i.name, type: i.type, origin: i.flags?.dnd5e?.advancementOrigin ?? null,
      compendiumSource: i._stats?.compendiumSource ?? null
    }));
    step.valueAfter = safe(getAdv()?.value);
  } catch ( err ) {
    step.error = { message: err.message, stack: err.stack?.split("\n").slice(0, 6).join("\n") };
  }
}

/* -------------------------------------------- */

/** Hand-build the `data` argument for `apply`, per advancement type. `undefined` = nothing to apply. */
async function buildData(ctx, adv, level, step) {
  const config = adv.configuration;
  switch ( step.type ) {
    case "Trait": {
      const chosen = new Set();
      for ( let i = 0; i < 30; i++ ) {
        const { available } = await adv.unfulfilledChoices(chosen);
        if ( !available.length ) break;
        const option = [...available[0].choices.asSet()].find(k => !chosen.has(k));
        if ( !option ) {
          step.note = "an unfulfilled choice had no remaining options";
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
      if ( !count ) {
        step.note = `no choices at level ${level}`;
        return undefined;
      }
      let uuids = config.pool.map(p => p.uuid);
      step.poolSource = "configuration.pool";
      if ( uuids.length < count ) {
        uuids = await searchRestriction(config, ctx.rules);
        step.poolSource = "restriction search";
      }
      const held = new Set(ctx.actor.items.map(i => i._stats?.compendiumSource).filter(Boolean));
      const selected = uuids.filter(u => !held.has(u)).slice(0, count);
      step.poolSize = uuids.length;
      return { selected, ability: config.spell?.ability?.first?.() };
    }

    case "AbilityScoreImprovement": {
      const assignments = {};
      for ( const [k, v] of Object.entries(config.fixed ?? {}) ) if ( v ) assignments[k] = v;
      let points = config.points ?? 0;
      const open = Object.keys(CONFIG.DND5E.abilities)
        .filter(k => !config.locked?.has?.(k) && adv.canImprove(k) && !assignments[k]);
      for ( const k of open ) {
        if ( points <= 0 ) break;
        const add = Math.min(config.cap ?? 2, points);
        assignments[k] = add;
        points -= add;
      }
      return { type: "asi", assignments };
    }

    case "Size":
      return { size: config.sizes?.first?.() ?? "med" };

    case "Subclass": {
      const identifier = adv.item.identifier;
      for ( const packId of ctx.picks.subclassPacks ) {
        const pack = game.packs.get(packId);
        if ( !pack ) continue;
        const index = await pack.getIndex({ fields: ["type", "system.classIdentifier"] });
        const entry = index.find(e => e.type === "subclass" && e.system?.classIdentifier === identifier);
        if ( entry ) return { uuid: entry.uuid };
      }
      step.note = `no subclass found for ${identifier}`;
      return undefined;
    }

    case "HitPoints":
      return { [level]: "max" };

    case "ScaleValue":
      return {};

    default:
      step.note = "UNKNOWN advancement type — the wizard must block on this";
      return undefined;
  }
}

/** Find items satisfying an ItemChoice restriction when the pool is empty or too small. */
async function searchRestriction(config, rules) {
  const { type, restriction = {} } = config;
  if ( type === "spell" ) {
    let uuids = [];
    for ( const key of restriction.list ?? [] ) {
      const [listType, identifier] = key.split(":");
      const list = dnd5e.registry.spellLists.forType(listType, identifier);
      if ( list ) uuids.push(...list.uuids);
    }
    if ( restriction.level !== "" && restriction.level != null ) {
      const wanted = Number(restriction.level);
      const levels = await Promise.all(uuids.map(async u => (await fromUuid(u))?.system.level));
      uuids = uuids.filter((u, i) => levels[i] === wanted);
    }
    return uuids;
  }
  const want = rules === "modern" ? "2024" : "2014";
  const out = [];
  for ( const pack of game.packs.filter(p => p.documentName === "Item" && p.collection.startsWith("dnd5e.")) ) {
    const index = await pack.getIndex({ fields: ["type", "system.type.value", "system.type.subtype", "system.source.rules"] });
    for ( const e of index ) {
      if ( type && e.type !== type ) continue;
      if ( restriction.type && e.system?.type?.value !== restriction.type ) continue;
      if ( restriction.subtype && e.system?.type?.subtype !== restriction.subtype ) continue;
      if ( e.system?.source?.rules && e.system.source.rules !== want ) continue;
      out.push(e.uuid);
    }
  }
  return out;
}

/** Plain-JSON copy of a value (DataModels, Sets). */
function safe(value) {
  if ( value === undefined || value === false || value === null ) return value;
  try {
    const plain = value?.toObject ? value.toObject() : value;
    return JSON.parse(JSON.stringify(plain, (_k, v) => (v instanceof Set ? [...v] : v)));
  } catch {
    return String(value);
  }
}

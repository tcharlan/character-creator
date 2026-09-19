/*
 * SPIKE 1.9 — throwaway. Inventory of every advancement type and configuration in the SRD packs of a
 * rule set (read from the pack index, no documents loaded), plus a build of every class and the open
 * items from earlier spikes. Fixes the exact scope of the choice widgets (D14).
 * The owner's PHB data is inventoried the same way on staging (Phase 5).
 */

import { buildCharacter, snapshot, compare, normalizeUuid } from "./lib.mjs";
import { extractRecipe, replay } from "./replay.mjs";

export const KNOWN_TYPES = ["AbilityScoreImprovement", "HitPoints", "ItemChoice", "ItemGrant", "ScaleValue", "Size",
  "Subclass", "Trait"];
export const INVENTORY_PACKS = {
  legacy: ["dnd5e.classes", "dnd5e.subclasses", "dnd5e.races", "dnd5e.backgrounds", "dnd5e.classfeatures"],
  modern: ["dnd5e.classes24", "dnd5e.origins24", "dnd5e.feats24"]
};
const CLASS_PACK = { legacy: "dnd5e.classes", modern: "dnd5e.classes24" };

/** Levels an advancement applies at. */
function levelsOf(a) {
  const c = a.configuration ?? {};
  if ( a.type === "ItemChoice" ) return Object.entries(c.choices ?? {}).filter(([, v]) => (v?.count ?? v) > 0).map(([k]) => Number(k));
  if ( a.type === "ScaleValue" ) return Object.keys(c.scale ?? {}).map(Number);
  if ( a.type === "HitPoints" ) return [1];
  return [Number(a.level ?? 0)];
}

/** A short configuration fingerprint per type (what a widget has to support). */
function fingerprint(a) {
  const c = a.configuration ?? {};
  const prefix = k => String(k).split(":")[0];
  switch ( a.type ) {
    case "Trait": {
      const keys = [...(c.grants ?? []), ...(c.choices ?? []).flatMap(ch => ch.pool ?? [])];
      return { mode: c.mode ?? "default", replacements: !!c.allowReplacements, choices: (c.choices ?? []).length > 0,
        prefixes: [...new Set(keys.map(prefix))].sort().join(","), wildcard: keys.some(k => String(k).endsWith("*")) };
    }
    case "ItemChoice":
      return { type: c.type ?? null, pool: (c.pool ?? []).length > 0, restriction: Object.entries(c.restriction ?? {})
        .filter(([, v]) => (Array.isArray(v) ? v.length : v)).map(([k]) => k).sort().join(","),
      spell: c.spell ? { abilities: (c.spell.ability ?? []).length, method: c.spell.method ?? "", prepared: c.spell.prepared ?? 0,
        uses: !!c.spell.uses?.max } : null,
      replacement: Object.values(c.choices ?? {}).some(v => v?.replacement), drops: c.allowDrops !== false };
    case "ItemGrant":
      return { optional: !!c.optional || (c.items ?? []).some(i => i.optional),
        spell: c.spell ? { abilities: (c.spell.ability ?? []).length, method: c.spell.method ?? "", uses: !!c.spell.uses?.max } : null };
    case "AbilityScoreImprovement":
      return { points: c.points ?? 0, fixed: Object.values(c.fixed ?? {}).some(Boolean), cap: c.cap ?? null,
        locked: (c.locked ?? []).length, max: c.max ?? null, recommendation: !!c.recommendation };
    case "Size":
      return { sizes: (c.sizes ?? []).length };
    case "ScaleValue":
      return { type: c.type ?? null };
    default:
      return {};
  }
}

/** Scan the rule set's SRD packs. */
export async function scan(rules) {
  const rows = [];
  for ( const packId of INVENTORY_PACKS[rules] ) {
    const index = await game.packs.get(packId).getIndex({ fields: ["type", "system.advancement", "system.source.rules"] });
    for ( const e of index ) {
      const advs = Object.values(e.system?.advancement ?? {});
      for ( const a of advs ) {
        rows.push({ pack: packId, item: e.name, itemType: e.type, type: a.type, title: a.title ?? "",
          levels: levelsOf(a), classRestriction: a.classRestriction ?? null, fp: fingerprint(a) });
      }
    }
  }
  return rows;
}

/** Summarise: per type, total and at levels 0–1, with the distinct fingerprints at 0–1. */
export function summarise(rows) {
  const out = {};
  for ( const r of rows ) {
    const t = out[r.type] ??= { total: 0, level01: 0, fingerprints: {} };
    t.total++;
    if ( r.levels.some(l => l <= 1) ) {
      t.level01++;
      const key = JSON.stringify(r.fp);
      const f = t.fingerprints[key] ??= { n: 0, examples: [] };
      f.n++;
      if ( f.examples.length < 3 ) f.examples.push(`${r.item}/${r.title}`);
    }
  }
  return out;
}

/** Build every class (fixed species/background), replay it and validate. */
export async function buildAllClasses(rules) {
  const pack = game.packs.get(CLASS_PACK[rules]);
  const index = await pack.getIndex({ fields: ["type"] });
  const rows = [];
  for ( const e of index.filter(x => x.type === "class").sort((a, b) => a.name.localeCompare(b.name)) ) {
    const row = { name: e.name, errors: [] };
    try {
      const built = await buildCharacter(rules, { picks: { class: [[pack.collection, e.name, "class"]] } });
      row.steps = built.steps.length;
      row.types = [...new Set(built.steps.map(s => s.type))].sort();
      row.items = built.actor.items.size;
      row.errors.push(...built.steps.filter(s => s.error).map(s => `${s.key}: ${s.error}`));
      row.notes = built.steps.filter(s => s.note).map(s => `${s.key}: ${s.note}`);
      const recipe = JSON.parse(JSON.stringify(extractRecipe(built, rules)));
      const replayed = await replay(recipe);
      row.replayErrors = replayed.errors;
      row.replayEqual = compare(snapshot(replayed.actor), snapshot(built.actor)).equal;
      row.hp = built.actor.system.attributes.hp.max;
    } catch ( err ) {
      row.errors.push(err.message);
    }
    rows.push(row);
  }
  return rows;
}

/** 2024 Cleric Divine Order / Druid Primal Order: how does the extra-cantrip option arrive? */
export async function orderOption(className, advTitle, optionName) {
  const pack = game.packs.get("dnd5e.classes24");
  const entry = (await pack.getIndex({ fields: ["type"] })).find(x => x.type === "class" && x.name === className);
  const cls = await pack.getDocument(entry._id);
  const adv = cls.advancement.byType.ItemChoice?.find(a => a.title === advTitle);
  if ( !adv ) return { error: `no ItemChoice "${advTitle}" on ${className}` };
  const pool = await Promise.all(adv.configuration.pool.map(async p => ({ uuid: p.uuid, name: (await fromUuid(p.uuid))?.name })));
  const option = pool.find(p => p.name === optionName) ?? pool.find(p => p.name?.includes(optionName));
  if ( !option ) return { error: `no option "${optionName}" in ${JSON.stringify(pool.map(p => p.name))}` };
  const built = await buildCharacter("modern", {
    picks: { class: [["dnd5e.classes24", className, "class"]] },
    overrides: { [`${className}/${advTitle}`]: { selected: [option.uuid] } }
  });
  const optionItem = built.actor.items.find(i => normalizeUuid(i._stats?.compendiumSource) === normalizeUuid(option.uuid));
  const nested = built.steps.filter(s => s.itemId === optionItem?.id).map(s => ({ type: s.type, key: s.key, data: s.data }));
  const cantripsOnActor = built.actor.items.filter(i => i.type === "spell" && i.system.level === 0).map(i => i.name);
  const identifier = cls.identifier;
  const effects = optionItem?.effects.map(ef => ({ name: ef.name, changes: ef.system?.changes ?? [] })) ?? [];
  const recipe = JSON.parse(JSON.stringify(extractRecipe(built, "modern")));
  const replayed = await replay(recipe);
  return {
    pool: pool.map(p => p.name), option: optionName, nested, effects,
    scaleCantrips: built.actor.system.scale?.[identifier]?.["cantrips-known"]?.value ?? null,
    scaleCantripsRaw: (v => ({ type: typeof v, value: typeof v === "object" ? v?.value ?? String(v) : v }))(built.actor.system.scale?.[identifier]?.["cantrips-known"]),
    cantripsOnActor, replayErrors: replayed.errors,
    replayEqual: compare(snapshot(replayed.actor), snapshot(built.actor)).equal
  };
}

/** 2014 domain spells: does any subclass grant spell items (at any level)? */
export async function subclassSpellGrants() {
  const index = await game.packs.get("dnd5e.subclasses").getIndex({ fields: ["type", "system.advancement", "system.classIdentifier"] });
  const out = [];
  for ( const e of index ) {
    const grants = Object.values(e.system?.advancement ?? {}).filter(a => a.type === "ItemGrant");
    const spells = [];
    for ( const g of grants ) {
      for ( const it of g.configuration?.items ?? [] ) {
        const doc = await fromUuid(it.uuid);
        if ( doc?.type === "spell" ) spells.push(`${doc.name}@${g.level}`);
      }
    }
    out.push({ subclass: e.name, class: e.system?.classIdentifier, advancementTypes: [...new Set(Object.values(e.system?.advancement ?? {}).map(a => a.type))], spellGrants: spells });
  }
  return out;
}

/** The duplicate-source case (Human Versatile = Magic Initiate while Sage grants it too). */
export async function duplicateSourceReplay() {
  const built = await buildCharacter("modern", {
    overrides: { "Human/Versatile": { selected: ["Compendium.dnd5e.feats24.Item.phbftMagicInitia"] } }
  });
  const recipe = JSON.parse(JSON.stringify(extractRecipe(built, "modern")));
  const miPaths = [...new Set(recipe.steps.filter(s => s.item.endsWith("phbftMagicInitia")).map(s => JSON.stringify(s.path)))];
  const replayed = await replay(recipe);
  const legacyRecipe = { ...recipe, steps: recipe.steps.map(({ path: _path, ...s }) => s) }; // without paths
  const legacyReplay = await replay(legacyRecipe);
  return {
    copies: built.actor.items.filter(i => i.name === "Magic Initiate").length, miPaths,
    withPaths: { errors: replayed.errors, equal: compare(snapshot(replayed.actor), snapshot(built.actor)).equal },
    withoutPaths: { errors: legacyReplay.errors.map(e => e.code),
      equal: compare(snapshot(legacyReplay.actor), snapshot(built.actor)).equal }
  };
}

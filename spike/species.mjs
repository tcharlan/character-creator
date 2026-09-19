/*
 * SPIKE 1.8 — throwaway. Species structure: 2014 races/subraces and 2024 lineage/ancestry choices.
 *
 * Question: how are subraces and lineages represented in dnd5e's SRD data, so step 1 can present them?
 * Method: for every species of the rule set, build a full level-1 character (fixed background and class),
 * summarise the species' own choices (incl. items it grants that have advancements of their own), and
 * replay the recipe through the spike 1.3 validator.
 */

import { buildCharacter, snapshot, compare, normalizeUuid } from "./lib.mjs";
import { extractRecipe, replay } from "./replay.mjs";

export const SPECIES_PACKS = { legacy: "dnd5e.races", modern: "dnd5e.origins24" };

async function nameOf(uuid) {
  return (await fromUuid(uuid))?.name ?? `? ${uuid}`;
}

/** Summarise one advancement's configuration for the report (choices only; grants by name). */
async function describe(adv, level) {
  const c = adv.configuration;
  switch ( adv.type ) {
    case "Trait":
      return { grants: [...c.grants], choices: c.choices.map(ch => ({ count: ch.count, pool: [...ch.pool] })) };
    case "ItemChoice":
      return { count: c.choices[level]?.count ?? 0, type: c.type, restriction: c.restriction?.toObject?.() ?? c.restriction,
        pool: await Promise.all(c.pool.map(p => nameOf(p.uuid))) };
    case "ItemGrant":
      return { items: await Promise.all(c.items.map(i => nameOf(i.uuid))), optional: c.optional,
        spellAbility: c.spell ? [...(c.spell.ability ?? [])] : null };
    case "AbilityScoreImprovement":
      return { fixed: Object.fromEntries(Object.entries(c.fixed).filter(([, v]) => v)), points: c.points, cap: c.cap,
        locked: [...c.locked] };
    case "Size":
      return { sizes: [...c.sizes] };
    default:
      return {};
  }
}

export async function survey(rules) {
  const packId = SPECIES_PACKS[rules];
  const pack = game.packs.get(packId);
  const index = await pack.getIndex({ fields: ["type", "system.identifier", "system.type.value", "system.type.subtype"] });
  const rows = [];
  for ( const e of index.filter(x => x.type === "race").sort((a, b) => a.name.localeCompare(b.name)) ) {
    const row = { name: e.name, identifier: e.system?.identifier, creatureType: e.system?.type?.value,
      subtype: e.system?.type?.subtype || null, steps: [], errors: [] };
    try {
      const built = await buildCharacter(rules, { picks: { species: [[packId, e.name, "race"]] } });
      const speciesId = built.ids.species;
      // The species' own steps, plus those of items it granted (lineages, ancestries, feats).
      const fromSpecies = new Set([speciesId]);
      for ( const s of built.steps ) {
        const item = built.actor.items.get(s.itemId);
        const origin = item?.flags?.dnd5e?.advancementOrigin?.split(".")[0];
        if ( s.itemId === speciesId || fromSpecies.has(origin) ) {
          fromSpecies.add(s.itemId);
          const adv = item.advancement.byId[s.advancementId];
          row.steps.push({ item: item.name, type: s.type, title: adv.title, level: s.level,
            config: await describe(adv, s.level), data: s.data, error: s.error ?? null });
        }
      }
      row.errors.push(...built.steps.filter(s => s.error).map(s => `${s.key}: ${s.error}`));
      const spells = built.actor.items.filter(i => i.type === "spell" && fromSpecies.has(i.flags?.dnd5e?.advancementOrigin?.split(".")[0]));
      row.spells = spells.map(i => `${i.name} (L${i.system.level}, ${i.system.method || "—"}, ${i.system.ability || "—"})`);
      row.size = built.actor.system.traits.size;
      row.speed = built.actor.system.attributes.movement?.walk;
      const senses = built.actor.system.attributes.senses ?? {};
      row.darkvision = senses.ranges?.darkvision ?? senses.darkvision ?? 0;
      row.actorCreatureType = built.actor.system.details.type?.value ?? null;
      row.raceSpeed = (await fromUuid(`Compendium.${packId}.Item.${e._id}`))?.system.movement?.walk ?? null;

      const recipe = JSON.parse(JSON.stringify(extractRecipe(built, rules)));
      const replayed = await replay(recipe);
      row.replayErrors = replayed.errors;
      row.replayEqual = compare(snapshot(replayed.actor), snapshot(built.actor)).equal;
      // Duplicate sources would make the recipe ambiguous (spike 1.3 open point).
      const srcs = built.actor.items.map(i => normalizeUuid(i._stats?.compendiumSource)).filter(Boolean);
      row.duplicateSources = [...new Set(srcs.filter((s, i) => srcs.indexOf(s) !== i))];
    } catch ( err ) {
      row.errors.push(err.message);
    }
    rows.push(row);
  }
  return rows;
}

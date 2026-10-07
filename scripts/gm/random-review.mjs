/**
 * The GM's side of a random character (D31): find the roll message, replay the loop with those totals against
 * this world's content, and hand the result to `checkRandomDraft`. The Foundry half of random-check.mjs.
 */

import { buildCharacter, buildInput } from "../rules/build.mjs";
import { equipmentContext } from "../rules/equipment-items.mjs";
import { checkRandomDraft } from "../rules/random-check.mjs";
import { readRollRecord, rollMessagesFor } from "../rules/roll-messages.mjs";
import { ROLL_PURPOSE } from "../rules/roll-record.mjs";
import { syncRecipe } from "../wizard/picks.mjs";
import { alignmentOptions, PERSONALITY } from "../wizard/details-step.mjs";
import { readSettings } from "../settings/settings.mjs";
import { stageConfig } from "../rules/random-stages.mjs";
import { incrementalBuilder } from "../rules/rebuild-cache.mjs";

/** A personality table's entries for a background, in the order the table lists them. */
async function personalityEntries(backgroundName, field) {
  if ( !backgroundName ) return [];
  const label = PERSONALITY[field];
  for ( const pack of game.packs.filter(p => (p.documentName === "RollTable") && p.visible) ) {
    const index = await pack.getIndex();
    const entry = index.find(e => e.name === `${label} (${backgroundName})`);
    if ( !entry ) continue;
    const table = await fromUuid(entry.uuid);
    return [...(table?.results ?? [])]
      .sort((a, b) => (a.range?.[0] ?? 0) - (b.range?.[0] ?? 0))
      .map(r => String(r.description ?? r.text ?? r.name ?? "").trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Check a submitted hardcore character against the rolls that made it.
 * @param {object} draft   A migrated, well-formed draft (`mode: "hardcore"`).
 * @param {{ catalog: object, userId: string }} options
 * @returns {Promise<object[]>} makeError() objects
 */
export async function checkRandomCharacter(draft, { catalog, userId }) {
  const settings = readSettings();
  const { free, attempts } = settings.hardcore;
  const { hitPointMethod } = settings.levels;
  // Every message this draft's rolls were posted in, oldest first (rollMessagesFor sorts by creation).
  const onRecord = rollMessagesFor(draft.id, userId, ROLL_PURPOSE.RANDOM);
  const records = onRecord.map(id => readRollRecord(game.messages.get(id))).filter(Boolean);
  let build = null;
  // The loop rebuilds once a round, a level at a time: each round replays from the level it changed (D38).
  const rebuildFrom = incrementalBuilder({ catalog, fill: true, withOptions: true, slice: true, hitPointMethod });
  return checkRandomDraft(draft, {
    records, userId, free, attempts,
    replay: {
      catalog,
      stages: stageConfig(settings, catalog),
      rebuild: async (d, { reference = false } = {}) => {
        if ( reference ) return buildCharacter(buildInput(d), { catalog, fill: true, withOptions: true, slice: true, hitPointMethod });
        build = await rebuildFrom(buildInput(d));
        return build;
      },
      equipmentContext: async (role, from = build) => {
        const item = from?.actor?.items?.get(from.roots?.[role]);
        return item ? equipmentContext(from.actor, item, catalog) : null;
      },
      // The creator keeps the automatic answers in the recipe too (D18), so the replay does the same before
      // the two recipes are compared.
      finish: async replayed => {
        const built = await buildCharacter(buildInput(replayed), { catalog, fill: true, withOptions: true, slice: true,
          hitPointMethod });
        replayed.recipe = { steps: syncRecipe(replayed.recipe.steps, built) };
        return replayed;
      },
      alignments: alignmentOptions(),
      // Only a 2014 background has personality tables (D31). The 2014 SRD tables are in a 2024 world's packs too,
      // and a 2024 background of the same name ("Acolyte") must not pick them up.
      tables: field => (draft.rules === "legacy"
        ? personalityEntries(build?.actor?.items?.get(build.roots?.background)?.name ?? null, field) : [])
    }
  });
}

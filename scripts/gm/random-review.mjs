/**
 * The GM's side of a random character (D31): find the roll message, replay the loop with those totals against
 * this world's content, and hand the result to `checkRandomDraft`. The Foundry half of random-check.mjs.
 */

import { buildCharacter } from "../rules/build.mjs";
import { equipmentContext } from "../rules/equipment-items.mjs";
import { checkRandomDraft } from "../rules/random-check.mjs";
import { readRollRecord, rollMessagesFor } from "../rules/roll-messages.mjs";
import { ROLL_PURPOSE } from "../rules/roll-record.mjs";
import { syncRecipe } from "../wizard/picks.mjs";
import { alignmentOptions, PERSONALITY } from "../wizard/details-step.mjs";
import { readSettings } from "../settings/settings.mjs";

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
  const free = readSettings().hardcore.free;
  // Every message this draft's rolls were posted in, oldest first (rollMessagesFor sorts by creation).
  const onRecord = rollMessagesFor(draft.id, userId, ROLL_PURPOSE.RANDOM);
  const records = onRecord.map(id => readRollRecord(game.messages.get(id))).filter(Boolean);
  let build = null;
  return checkRandomDraft(draft, {
    records, userId, free,
    replay: {
      catalog,
      rebuild: async d => {
        build = await buildCharacter({ picks: d.picks, base: d.abilities.base, steps: d.recipe.steps },
          { catalog, fill: true, withOptions: true });
        return build;
      },
      equipmentContext: async role => {
        const item = build?.actor?.items?.get(build.roots?.[role]);
        return item ? equipmentContext(build.actor, item, catalog) : null;
      },
      // The creator keeps the automatic answers in the recipe too (D18), so the replay does the same before
      // the two recipes are compared.
      finish: async replayed => {
        const built = await buildCharacter({ picks: replayed.picks, base: replayed.abilities.base,
          steps: replayed.recipe.steps }, { catalog, fill: true, withOptions: true });
        replayed.recipe = { steps: syncRecipe(replayed.recipe.steps, built) };
        return replayed;
      },
      alignments: alignmentOptions(),
      tables: field => personalityEntries(build?.actor?.items?.get(build.roots?.background)?.name ?? null, field)
    }
  });
}

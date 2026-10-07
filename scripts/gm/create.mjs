/**
 * The creator (PLAN 2.7): turn a validated draft into the character. It uses only what the validator rebuilt
 * and resolved (convention 9) — the replayed actor, the resolved equipment, the checked spells — never the
 * player's own computed values.
 */

import { MODULE_ID, SCHEMA_VERSION } from "../contracts.mjs";
import { equipmentCreationData } from "../rules/equipment-items.mjs";
import { spellCreationData, classRoots, selectionFor } from "../rules/spell-facts.mjs";
import { addCurrency } from "../rules/equipment.mjs";
import { detailsData } from "./details.mjs";

/** Actor flag marking a character this module created: `{ draftId, userId, rules, schema, createdAt }`. */
export const CREATED_FLAG = "created";

/**
 * The Actor folder for new characters (the setting), created if missing; null for no folder.
 *
 * A folder of that name already in the world is used wherever it sits, so a GM who has tidied it inside
 * another folder doesn't end up with a second one at the top (PLAN 4.4). The top-level one wins when there
 * are several.
 */
export async function ensureFolder(name) {
  const wanted = String(name ?? "").trim();
  if ( !wanted ) return null;
  const matches = game.folders.filter(f => (f.type === "Actor") && (f.name === wanted));
  const existing = matches.find(f => !f.folder) ?? matches[0];
  return existing ?? foundry.utils.getDocumentClass("Folder").create({ name: wanted, type: "Actor" });
}

/** The flag data of an actor this module created, or null. */
export const createdFlag = actor => actor?.getFlag(MODULE_ID, CREATED_FLAG) ?? null;

/** Characters this module created for a user (the character limit, A4). */
export const createdFor = userId => game.actors.filter(a => createdFlag(a)?.userId === userId);

/** The character already created from this draft for this user, if any (idempotency). */
export const createdFrom = (draftId, userId) => game.actors.find(a => {
  const f = createdFlag(a);
  return f?.draftId === draftId && f?.userId === userId;
}) ?? null;

/**
 * Creation data for a validated draft.
 * @param {{ draft, built, equipment }} validated   From validateDraft() with ok = true.
 * @param {{ user: User, catalog: object, folderId?: string|null, goldPerLevel?: number }} options
 */
export async function characterData({ draft, built, equipment }, { user, catalog, folderId = null, goldPerLevel = 0 }) {
  const data = built.actor.toObject();
  delete data._id;
  const details = detailsData(draft.details, `${user.name}'s character`);
  data.name = details.name;
  data.prototypeToken = { ...(data.prototypeToken ?? {}), name: details.name };
  foundry.utils.mergeObject(data.system, details.system);
  const L = CONST.DOCUMENT_OWNERSHIP_LEVELS;
  data.ownership = { default: L.NONE, [user.id]: L.OWNER };
  data.folder = folderId;
  foundry.utils.setProperty(data, `flags.${MODULE_ID}.${CREATED_FLAG}`, {
    draftId: draft.id, userId: user.id, rules: draft.rules, schema: SCHEMA_VERSION, createdAt: Date.now()
  });

  data.items.push(...await equipmentCreationData(equipment.items));
  for ( const root of classRoots(built) ) {
    data.items.push(...await spellCreationData(built, selectionFor(draft, root), { catalog, root }));
  }
  // The GM's gold for each level above the first (D34), on top of what the equipment gives.
  const extra = goldPerLevel * Math.max(0, (draft.level ?? 1) - 1);
  const currency = addCurrency({ ...(data.system.currency ?? {}) }, extra ? addCurrency({ ...equipment.currency }, { gp: extra })
    : equipment.currency);
  data.system.currency = currency;
  // Start at full hit points (the replayed actor's maximum).
  foundry.utils.setProperty(data, "system.attributes.hp.value", built.actor.system.attributes.hp.max);
  return data;
}

/**
 * Create the character. `keepEmbeddedIds` keeps the advancement links (`advancementOrigin`, container
 * contents) that point at embedded item ids (spike 1.4).
 */
export async function createCharacter(validated, { folderName = "", ...options } = {}) {
  const folder = await ensureFolder(folderName);
  const data = await characterData(validated, { ...options, folderId: folder?.id ?? null });
  return Actor.implementation.create(data, { keepEmbeddedIds: true });
}

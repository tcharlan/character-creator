/*
 * PHASE 1 "DONE WHEN" — throwaway. Puts spikes 1.1–1.9 together end to end:
 * a Player-role user builds a complete level-1 character (recipe, starting equipment, spells, portrait)
 * and submits it; the active GM replays and validates every part from the compendium data, then creates
 * the actor with its items (containers with contents), currency, spells, portrait, ownership and
 * user.character. Nothing the player computed is trusted (convention 3).
 */

import { buildCharacter, normalizeUuid } from "./lib.mjs";
import { extractRecipe, replay } from "./replay.mjs";
import { buildTree, defaultSelection, resolveSelection } from "./equipment-core.mjs";
import { equipmentIndex, candidatesFor, proficiencyChecker, creationData } from "./equipment.mjs";
import { requirements, validateSpells, spellStates } from "./spells-core.mjs";
import { spellLevels, factsFromActor } from "./spells.mjs";
import { preparePortrait, makeTestImage, savePortrait } from "./portrait.mjs";

const MODULE_ID = "character-creator";
export const SUBMIT_FULL = `${MODULE_ID}.spikeSubmitFull`;

/** The two Phase 1 characters (PLAN.md → Phase 1 "Done when"). */
export const SPECS = {
  legacy: { name: "Phase 1 Wizard", picks: {
    species: [["dnd5e.races", "High Elf", "race"]], background: [["dnd5e.backgrounds", "Acolyte", "background"]],
    class: [["dnd5e.classes", "Wizard", "class"]] } },
  modern: { name: "Phase 1 Fighter", picks: {
    species: [["dnd5e.origins24", "Dwarf", "race"]], background: [["dnd5e.origins24", "Soldier", "background"]],
    class: [["dnd5e.classes24", "Fighter", "class"]] } }
};

/* -------------------------------------------- */
/*  Shared (player preview and GM validation)   */
/* -------------------------------------------- */

/** Resolve one source item's starting equipment selection against the catalog and the character. */
async function resolveEquipment(actor, item, selection, index) {
  const tree = buildTree(item.system.toObject().startingEquipment ?? []);
  const linked = [...tree.nodes.values()].filter(n => n.type === "linked").map(n => n.key);
  const isProficient = await proficiencyChecker(actor, linked);
  const inCategory = (n, u) => candidatesFor(n, index).map(normalizeUuid).includes(normalizeUuid(u));
  return { tree, isProficient, result: resolveSelection(tree, item.system.wealth, selection, { inCategory, isProficient }) };
}

/* -------------------------------------------- */
/*  Player side                                 */
/* -------------------------------------------- */

/** Build the complete submission a player would send (default picks everywhere). */
export async function prepareSubmission(rules, spec = SPECS[rules]) {
  const built = await buildCharacter(rules, { picks: spec.picks });
  const recipe = JSON.parse(JSON.stringify(extractRecipe(built, rules)));
  const index = await equipmentIndex(rules);

  const equipment = {};
  const expected = { items: [], currency: {} };
  for ( const role of ["class", "background"] ) {
    const item = built.actor.items.find(i => i.type === role);
    const tree = buildTree(item.system.toObject().startingEquipment ?? []);
    const linked = [...tree.nodes.values()].filter(n => n.type === "linked").map(n => n.key);
    const isProficient = await proficiencyChecker(built.actor, linked);
    equipment[role] = defaultSelection(tree, { candidates: n => candidatesFor(n, index), isProficient });
    const { result } = await resolveEquipment(built.actor, item, equipment[role], index);
    expected.items.push(...result.items);
    for ( const [k, v] of Object.entries(result.currency) ) expected.currency[k] = (expected.currency[k] ?? 0) + v;
  }

  // Spells: counts from the fully built character (spike 1.9); skip spells the character already has.
  const levels = await spellLevels(rules);
  const cls = built.actor.items.find(i => i.type === "class");
  const facts = factsFromActor(built.actor, cls, levels);
  const req = requirements(facts);
  const owned = new Set(built.actor.items.filter(i => i.type === "spell").map(i => normalizeUuid(i._stats?.compendiumSource)));
  const list = [...facts.live.listUuids].filter(u => !owned.has(u));
  const cantrips = list.filter(u => levels.get(u) === 0).slice(0, req.cantrips);
  const lvl1 = list.filter(u => levels.get(u) === 1);
  const spellbook = lvl1.slice(0, req.spellbook);
  const spells = { cantrips, spellbook, spells: (req.spellbook ? spellbook : lvl1).slice(0, req.spells) };

  const image = await preparePortrait(await makeTestImage(1200, 1600));
  const ring = { ring: "#c9a227", background: "#1b2a49", effects: 1 };
  return {
    built, req,
    payload: { recipe, equipment, spells, image, ring, draftId: foundry.utils.randomID(), name: spec.name },
    expected: { ...expected, hp: built.actor.system.attributes.hp.max, speed: built.actor.system.attributes.movement.walk }
  };
}

/* -------------------------------------------- */
/*  GM side                                     */
/* -------------------------------------------- */

export function registerPhase1Queries() {
  CONFIG.queries[SUBMIT_FULL] = handleSubmitFull;
}

const isActiveGM = () => game.user.isGM && game.users.activeGM?.isSelf;
const reject = (step, errors) => ({ ok: false, step, errors });

async function handleSubmitFull(data, { user }) {
  if ( !isActiveGM() ) throw new Error("Only the active GM handles submissions");
  const t0 = performance.now();
  const { recipe, equipment = {}, spells = {}, image, ring, draftId, name } = data ?? {};
  if ( typeof draftId !== "string" || !recipe?.steps ) return reject("start", [{ code: "BAD_REQUEST" }]);
  const existing = game.actors.find(a => a.getFlag(MODULE_ID, "draftId") === draftId);
  if ( existing ) return { ok: true, actorUuid: existing.uuid, duplicate: true };
  const rules = game.settings.get("dnd5e", "rulesVersion");
  if ( recipe.rules !== rules ) return reject("start", [{ code: "RULES_MISMATCH" }]);

  // 1. Choices: replay and validate the recipe.
  const { actor, errors } = await replay(recipe);
  if ( errors.length ) return reject("choices", errors);
  const tReplay = performance.now();

  // 2. Equipment: each source item's selection, resolved against the catalog and this character.
  const index = await equipmentIndex(rules);
  const items = [];
  const currency = {};
  for ( const role of ["class", "background"] ) {
    const item = actor.items.find(i => i.type === role);
    const { result } = await resolveEquipment(actor, item, equipment[role] ?? {}, index);
    if ( result.errors.length ) return reject("equipment", result.errors.map(e => ({ ...e, source: role })));
    items.push(...result.items);
    for ( const [k, v] of Object.entries(result.currency) ) currency[k] = (currency[k] ?? 0) + v;
  }

  // 3. Spells: counts and lists from dnd5e's data on the replayed character.
  const levels = await spellLevels(rules);
  const cls = actor.items.find(i => i.type === "class");
  const facts = factsFromActor(actor, cls, levels);
  const req = requirements(facts);
  const spellErrors = validateSpells(req, spells, facts.live.listUuids, levels);
  const owned = new Set(actor.items.filter(i => i.type === "spell").map(i => normalizeUuid(i._stats?.compendiumSource)));
  const again = [...(spells.cantrips ?? []), ...(spells.spellbook ?? []), ...(spells.spells ?? [])].filter(u => owned.has(normalizeUuid(u)));
  if ( again.length ) spellErrors.push({ code: "ALREADY_KNOWN", detail: again });
  if ( spellErrors.length ) return reject("spells", spellErrors);

  // 4. Creation data: the replayed character + equipment (containers with contents) + spells + currency.
  const actorData = actor.toObject();
  delete actorData._id;
  actorData.name = (typeof name === "string" && name.trim()) || `${user.name}'s character`;
  actorData.ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, [user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };
  foundry.utils.setProperty(actorData, `flags.${MODULE_ID}`, { draftId, spike14: true });
  actorData.items.push(...await creationData(items));
  for ( const { uuid, prepared } of spellStates(req, spells) ) {
    const d = game.items.fromCompendium(await fromUuid(uuid));
    d._id = foundry.utils.randomID();
    Object.assign(d.system, { sourceItem: `class:${facts.identifier}`, method: req.method, prepared });
    actorData.items.push(d);
  }
  for ( const [k, v] of Object.entries(currency) ) {
    foundry.utils.setProperty(actorData, `system.currency.${k}`, (actorData.system.currency?.[k] ?? 0) + v);
  }

  // 5. Create, assign, then the portrait (a failed portrait never blocks the character).
  const created = await Actor.implementation.create(actorData, { keepEmbeddedIds: true });
  if ( !user.character ) await user.update({ character: created.id });
  const warnings = [];
  let portrait = null;
  if ( image ) {
    portrait = await savePortrait(created, image, ring, user);
    if ( !portrait.ok ) warnings.push({ code: "PORTRAIT_FAILED", detail: portrait.code });
  }
  return {
    ok: true, actorUuid: created.uuid, warnings, portrait: portrait?.path ?? null,
    diagnostics: { replayMs: Math.round(tReplay - t0), totalMs: Math.round(performance.now() - t0),
      items: created.items.size, currency }
  };
}

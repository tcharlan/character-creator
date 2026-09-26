/**
 * The random character (D31, "hardcore"): the dice make every choice the GM hasn't handed back to the player.
 *
 * One loop, used twice: the player's browser runs it with real dice and posts them to chat, and the GM's copy
 * runs it again with the recorded totals and compares the result with what was submitted. So the loop must be
 * **deterministic**: same content, same totals, same character. Candidates are therefore always sorted by UUID
 * (or by the order dnd5e lists them), never by name, which depends on the language.
 *
 * Pure apart from the callbacks it is given: `rebuild` (replay the character so far), `roll` (a die) and
 * `table` (a roll table's entries, for a 2014 background's personality).
 */

import { normalizeUuid } from "../catalog/filters.mjs";
import { applyPick, answerStep } from "../wizard/picks.mjs";
import { answerData } from "../wizard/choices-step.mjs";
import { sourceModel, setMode, chooseBranch, setPick, EQUIPMENT_SOURCES } from "../wizard/equipment-step.mjs";
import { setDetail, PERSONALITY } from "../wizard/details-step.mjs";

/** The parts of a character, in the order they are rolled. */
export const PART_ORDER = Object.freeze(["species", "class", "background", "abilities", "choices", "equipment",
  "details"]);

/** The details the dice settle (D31). The rest — the name, age, hair, the writing — stays the player's. */
export const ROLLED_DETAILS = Object.freeze(["alignment", "traits", "ideals", "bonds", "flaws"]);

/** The three picks, in the order the dice go in. */
const ROLE_ORDER = Object.freeze(["species", "class", "background"]);

/** Answering these brings new items or advancements with them, so the character has to be replayed after. */
const STRUCTURAL = Object.freeze(["ItemChoice", "ItemGrant", "Subclass"]);

/** Advancement types the loop can answer. Anything else is left for the player (the wizard flags it). */
const ANSWERABLE = Object.freeze(["Trait", "ItemChoice", "ItemGrant", "AbilityScoreImprovement", "Size", "Subclass"]);

const byUuid = list => [...list].sort((a, b) => String(a).localeCompare(String(b)));

/** One of a list, by a die result (1-based, as dice are). */
export const at = (list, total) => list[Math.min(Math.max(1, total), list.length) - 1];

/**
 * Roll one part's worth of decisions.
 * @param {object} options
 * @param {object} options.draft            Mutated in place.
 * @param {object} options.build            The latest replay (for the choices and equipment).
 * @param {object} options.catalog
 * @param {(faces: number, key: string) => Promise<number>} options.roll
 * @returns {Promise<boolean>}   Whether anything was decided (so the caller rebuilds and comes back).
 */

/* -------------------------------------------- */
/*  The parts                                   */
/* -------------------------------------------- */

/** Species, class and background: one die over what the GM allows, in UUID order. */
async function rollRole(draft, role, { catalog, roll }) {
  if ( draft.picks[role] ) return false;
  const uuids = byUuid((catalog?.byCategory?.[role] ?? []).map(e => normalizeUuid(e.uuid)));
  if ( !uuids.length ) return false;
  const total = await roll(uuids.length, role);
  applyPick(draft, role, at(uuids, total));
  return true;
}

/** One open advancement: the dice answer it the way a player would, then it is written to the recipe. */
async function rollChoice(draft, result, { roll }) {
  const { options, type } = result;
  const key = `choice:${result.key}`;
  let data = result.data ?? null;
  const answer = click => {
    const next = answerData({ ...result, data }, click);
    if ( next ) data = next;
  };
  switch ( type ) {
    case "Trait": {
      const need = (options.max ?? 0) - (data?.chosen?.length ?? 0);
      for ( let i = 0; i < need; i++ ) {
        const taken = new Set(data?.chosen ?? []);
        const left = (options.allowed ?? []).filter(k => !taken.has(k)).sort();
        if ( !left.length ) break;
        answer({ value: at(left, await roll(left.length, `${key}:${i}`)) });
      }
      break;
    }
    case "ItemChoice": {
      const need = (options.count ?? 0) - (data?.selected?.length ?? 0);
      for ( let i = 0; i < need; i++ ) {
        const taken = new Set(data?.selected ?? []);
        const left = byUuid((options.options ?? []).filter(u => !taken.has(u)));
        if ( !left.length ) break;
        answer({ value: at(left, await roll(left.length, `${key}:${i}`)) });
      }
      if ( (options.abilityOptions ?? []).length > 1 ) {
        const abilities = [...options.abilityOptions].sort();
        answer({ action: "ability", value: at(abilities, await roll(abilities.length, `${key}:ability`)) });
      }
      break;
    }
    case "ItemGrant": {
      // What is offered is taken: leaving a free feature behind is no kind of choice.
      for ( const item of options.items ?? [] ) if ( item.optional ) answer({ value: item.uuid });
      if ( (options.abilityOptions ?? []).length > 1 ) {
        const abilities = [...options.abilityOptions].sort();
        answer({ action: "ability", value: at(abilities, await roll(abilities.length, `${key}:ability`)) });
      }
      break;
    }
    case "AbilityScoreImprovement": {
      const improvable = [...(options.improvable ?? [])].sort();
      for ( let i = 0; i < (options.points ?? 0); i++ ) {
        const fixed = options.fixed ?? {};
        const spread = data?.assignments ?? fixed;
        const room = improvable.filter(a => !(options.locked ?? []).includes(a)
          && ((options.cap === null) || (((spread[a] ?? fixed[a] ?? 0) - (fixed[a] ?? 0)) < options.cap)));
        if ( !room.length ) break;
        answer({ action: "raise", value: at(room, await roll(room.length, `${key}:${i}`)) });
      }
      break;
    }
    case "Size": {
      const sizes = [...(options.sizes ?? [])].sort();
      if ( sizes.length ) answer({ value: at(sizes, await roll(sizes.length, key)) });
      break;
    }
    case "Subclass": {
      const uuids = byUuid(options.options ?? []);
      if ( uuids.length ) answer({ value: at(uuids, await roll(uuids.length, key)) });
      break;
    }
    default: return false;
  }
  if ( !data ) return false;
  answerStep(draft, result, data);
  return true;
}

/** The open choices the loop can answer, in the order the replay lists them. */
export function openChoices(build) {
  return (build?.results ?? []).filter(r => (r.status === "needsInput") && ANSWERABLE.includes(r.type));
}

/**
 * One source's equipment: the gear it offers (never the gold instead), then each either/or and each
 * "any simple weapon" slot.
 */
async function rollEquipment(draft, role, context, { catalog, roll }) {
  const key = `equipment:${role}`;
  const selection = draft.equipment[role];
  const model = () => sourceModel({ role, name: "", ...context }, draft.equipment[role], catalog);
  if ( !selection ) {
    // The gear the class and background offer, as an ordinary character takes it — never the bag of gold
    // instead: a character starting with nothing but coins has nothing to play with.
    setMode(draft, role, "items");
    return true;
  }
  if ( selection.mode === "wealth" ) return false;
  const decisions = model().decisions;
  const branch = decisions.find(d => (d.kind === "or") && !d.options.some(o => o.selected));
  if ( branch ) {
    const ids = branch.options.map(o => o.id);
    chooseBranch(draft, role, branch.id, at(ids, await roll(ids.length, `${key}:${branch.id}`)), context.tree);
    return true;
  }
  for ( const decision of decisions.filter(d => d.kind === "category") ) {
    for ( const slot of decision.slots ) {
      if ( slot.uuid ) continue;
      const uuids = byUuid(slot.options.map(o => o.uuid));
      if ( !uuids.length ) break;
      setPick(draft, role, decision.id, slot.index,
        at(uuids, await roll(uuids.length, `${key}:${decision.id}:${slot.index}`)));
      return true;
    }
  }
  return false;
}

/** Alignment, and a 2014 background's personality tables where it has them. */
async function rollDetails(draft, { alignments, tables, roll }) {
  if ( !draft.details.alignment && alignments.length ) {
    setDetail(draft, "alignment", at(alignments, await roll(alignments.length, "details:alignment")));
    return true;
  }
  for ( const field of Object.keys(PERSONALITY) ) {
    if ( draft.details[field] ) continue;
    const entries = await tables(field);
    if ( !entries?.length ) continue;
    setDetail(draft, field, at(entries, await roll(entries.length, `details:${field}`)));
    return true;
  }
  return false;
}

/* -------------------------------------------- */
/*  The loop                                    */
/* -------------------------------------------- */

/**
 * Make (or replay) a random character. Everything the GM hasn't handed back to the player is rolled; the parts
 * in `free` are left exactly as the draft has them.
 *
 * @param {object} options
 * @param {object} options.draft        Mutated in place, and returned.
 * @param {object} options.catalog
 * @param {string[]} [options.free]     Parts the player chooses (RANDOM_PARTS).
 * @param {(faces: number, key: string) => Promise<number>} options.roll   A die: 1…faces.
 * @param {(draft: object) => Promise<object>} options.rebuild             Replay the draft so far.
 * @param {(role: string) => Promise<object>} options.equipmentContext     The source's starting equipment.
 * @param {() => Promise<void>} [options.abilities]                        Roll the six scores (D15).
 * @param {string[]} [options.alignments]
 * @param {(field: string) => Promise<string[]>} [options.tables]          A personality table's entries.
 * @param {number} [options.maxDecisions]
 * @returns {Promise<object>} the draft
 */
export async function rollCharacter({ draft, catalog, free = [], roll, rebuild, equipmentContext,
  abilities = async () => {}, alignments = [], tables = async () => [], maxDecisions = 200 } = {}) {
  const rolls = part => !free.includes(part);
  // The three picks first: every other decision depends on them.
  for ( const role of ROLE_ORDER ) {
    if ( rolls(role) ) await rollRole(draft, role, { catalog, roll });
  }
  if ( rolls("abilities") ) await abilities();

  // Replaying the character is the slow part, so it happens as rarely as it can: only a choice that brings
  // new items or new advancements with it (a feat, a subclass) changes what is still open, so the others are
  // all answered from one replay. Equipment and the details change nothing that is replayed at all.
  let build = await rebuild(draft);
  if ( rolls("choices") ) {
    for ( let guard = 0; guard < maxDecisions; guard++ ) {
      let answered = false;
      let structural = false;
      for ( const result of openChoices(build) ) {
        if ( !await rollChoice(draft, result, { roll }) ) continue;
        answered = true;
        if ( STRUCTURAL.includes(result.type) ) {
          structural = true;
          break;
        }
      }
      if ( !answered ) break;
      build = await rebuild(draft);
      if ( !structural && !openChoices(build).length ) break;
    }
  }
  if ( rolls("equipment") ) {
    // Both sources are read at once (each one checks proficiencies); the rolling itself stays in order.
    const contexts = await Promise.all(EQUIPMENT_SOURCES.map(role => equipmentContext(role)));
    for ( const [i, role] of EQUIPMENT_SOURCES.entries() ) {
      const context = contexts[i];
      if ( !context ) continue;
      for ( let guard = 0; guard < maxDecisions; guard++ ) {
        if ( !await rollEquipment(draft, role, context, { catalog, roll }) ) break;
      }
    }
  }
  if ( rolls("details") ) {
    for ( let guard = 0; guard < maxDecisions; guard++ ) {
      if ( !await rollDetails(draft, { alignments, tables, roll }) ) break;
    }
  }
  return draft;
}

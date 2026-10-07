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
import { applyPick, answerStep, clearStep } from "../wizard/picks.mjs";
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

/**
 * An answer can stop fitting after something else is applied: the dice take Nature for a class's skills, and a
 * feature granted later grants Nature as well, which leaves the answer pointing at something no longer on offer.
 * A player would change it; in hardcore mode the step is closed to them, so the dice have to. These are the
 * complaints worth rolling again for — the answer is wrong, not the content.
 */
const REDOABLE = Object.freeze(["NOT_ALLOWED", "NOT_OFFERED", "TOO_MANY_PICKS", "UNFULFILLED"]);

/** How many times one decision may be rolled again before it is left alone (so the loop always ends). */
const REDO_LIMIT = 3;

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
  // Whatever answers are still under this role are the player's own (a pick from a shortlist, kept for the GM's
  // replay): a new pick would drop them, so they are put back.
  const kept = (draft.recipe?.steps ?? []).filter(st => st.path?.[0] === role);
  applyPick(draft, role, at(uuids, total));
  draft.recipe.steps.push(...kept);
  return true;
}

/** One open advancement: the dice answer it the way a player would, then it is written to the recipe. */
async function rollChoice(draft, result, { roll, feats = null }) {
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
      // Feats rolled outright (D36 "rolled"): a die for the increase or a feat, then one for the feat.
      if ( (feats?.mode === "rolled") && options.allowFeat && options.feats?.length ) {
        if ( await roll(2, `${key}:branch`) === 2 ) {
          const list = byUuid(options.feats);
          data = { type: "feat", uuid: at(list, await roll(list.length, `${key}:feat`)) };
          break;
        }
      }
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

/** Answered choices whose answer no longer fits, and which rolling again would settle. */
export function staleChoices(build) {
  return (build?.results ?? []).filter(r => (r.status === "invalid") && ANSWERABLE.includes(r.type)
    && (r.errors ?? []).some(e => REDOABLE.includes(e.code)));
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
    // Only what the character can use: "a warhammer (if proficient)" is not on offer to a Cleric without the
    // proficiency (the GM's copy refuses it, NOT_PROFICIENT). Where nothing is usable, any of them.
    const usable = branch.options.filter(o => !o.warning);
    const ids = (usable.length ? usable : branch.options).map(o => o.id);
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
/*  Stages: a rolled shortlist, the player picks */
/* -------------------------------------------- */

/**
 * Above level 1 some decisions are a rolled shortlist the player picks from (D35 classes to multiclass into, D36
 * feats at a feat slot, D39 subclasses). The loop rolls up to such a decision, rolls the shortlist, and stops
 * there until the player has picked: everything after it can depend on the pick. The shortlists live in
 * `draft.random.stages` by the decision's key (`multiclass`, or the recipe step's key).
 */
export const STAGE_KINDS = Object.freeze(["multiclass", "subclass", "feat"]);

/**
 * Roll `size` different entries from the candidates (UUID order); all of them where there are no more than that,
 * or `size` is 0 (every option, D39). In the order they were rolled.
 */
export async function rollShortlist(candidates, size, key, roll) {
  const pool = byUuid(candidates);
  if ( !size || (pool.length <= size) ) return pool;
  const out = [];
  for ( let i = 0; i < size; i++ ) {
    const left = pool.filter(u => !out.includes(u));
    out.push(at(left, await roll(left.length, `shortlist:${key}:${i}`)));
  }
  return out;
}

/** What a stage offers: the subclasses of the class the GM allows, or the feats the character qualifies for. */
const stageCandidates = (kind, result) => (kind === "subclass" ? (result.options?.options ?? []) : (result.options?.feats ?? []));

/** How long a stage's shortlist is (0: every option). A subclass the GM leaves to the player offers them all. */
function stageSize(kind, config, free = []) {
  if ( kind === "subclass" ) return free.includes("subclass") ? 0 : (config?.subclass?.size ?? 0);
  return config?.feats?.mode === "chosen" ? 0 : (config?.feats?.size ?? 0);
}

/** Which kind of stage a step of the replay is, given the GM's settings — or null when the dice decide it. */
export function stageKind(result, config) {
  if ( !config ) return null;
  // A subclass the GM leaves to the player is a stage too, offering every subclass (D39): that keeps the pick the
  // player's through a reroll and the GM's replay, like any other stage.
  if ( (result.type === "Subclass") && config.subclass ) return "subclass";
  if ( (result.type === "AbilityScoreImprovement") && result.options?.allowFeat
    && ["shortlist", "chosen"].includes(config.feats?.mode) ) return "feat";
  return null;
}

/**
 * Is this step the player's to answer — a stage, a choice inside a feat the player took at one, or a subclass
 * the GM left to the player? The dice never answer these.
 */
export function playerOwned(result, stages = {}) {
  if ( stages[result.key] ) return true;
  for ( const stage of Object.values(stages) ) {
    if ( (stage.kind !== "feat") || !stage.path ) continue;
    const p = result.path ?? [];
    if ( (p.length > stage.path.length) && stage.path.every((seg, i) => p[i] === seg)
      && String(p[stage.path.length]).startsWith(`${stage.advancementId}:`) ) return true;
  }
  return false;
}

/** The first character level the dice must wait at: an open stage or an open answer of the player's. */
export function blockedAt(build, stages = {}) {
  let level = Infinity;
  if ( stages.multiclass && !stages.multiclass.answered ) level = 1;
  for ( const r of build?.results ?? [] ) {
    if ( (r.status === "needsInput") && playerOwned(r, stages) ) level = Math.min(level, r.at ?? 1);
  }
  return level;
}

/** The stage the player is to answer now, or null: `{ key, kind, options }`. */
export function openStage(draft, build) {
  const stages = draft?.random?.stages ?? {};
  if ( stages.multiclass && !stages.multiclass.answered ) return { key: "multiclass", ...stages.multiclass };
  const open = (build?.results ?? []).find(r => (r.status === "needsInput") && stages[r.key]);
  return open ? { key: open.key, ...stages[open.key] } : null;
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
 * @param {(draft: object, options?: { reference?: boolean }) => Promise<object>} options.rebuild
 *   Replay the draft so far; `reference` asks for a side build (the level-1 character) that isn't the latest.
 * @param {(role: string, build?: object) => Promise<object>} options.equipmentContext   The source's starting
 *   equipment, read from the given build.
 * @param {() => Promise<void>} [options.abilities]                        Roll the six scores (D15).
 * @param {string[]} [options.alignments]
 * @param {(field: string) => Promise<string[]>} [options.tables]          A personality table's entries.
 * @param {number} [options.maxDecisions]
 * @returns {Promise<object>} the draft
 */
export async function rollCharacter({ draft, catalog, free = [], roll, rebuild, equipmentContext,
  abilities = async () => {}, alignments = [], tables = async () => [], maxDecisions = 200, stages: config = null } = {}) {
  const rolls = part => !free.includes(part);
  // The shortlists the player picks from (D35, D36, D39), kept on the draft's random record.
  draft.random ??= { attempt: 1, messageIds: [], rolls: [] };
  const stages = draft.random.stages ??= {};
  // The three picks first: every other decision depends on them.
  for ( const role of ROLE_ORDER ) {
    if ( rolls(role) ) await rollRole(draft, role, { catalog, roll });
  }
  if ( rolls("abilities") ) await abilities();

  // Classes to multiclass into (D35): above level 1, with the GM allowing it, rolled from the classes the
  // character qualifies for with its level-1 scores, before anything past level 1 is decided.
  // No stage where the first class would have to keep every level anyway (the GM's minimum, D35).
  if ( config?.multiclass && ((draft.level ?? 1) > Math.max(1, config.multiclass.firstMinimum ?? 1)) && draft.picks.class
    && !stages.multiclass?.options ) {
    const candidates = await config.multiclass.candidates(draft);
    const options = await rollShortlist(candidates, config.multiclass.size, "multiclass", roll);
    stages.multiclass = { kind: "multiclass", options, answered: stages.multiclass?.answered ?? !options.length };
  }

  // Replaying the character is the slow part, so it happens as rarely as it can: only a choice that brings
  // new items or new advancements with it (a feat, a subclass) changes what is still open, so the others are
  // all answered from one replay. Equipment and the details change nothing that is replayed at all.
  let build = await rebuild(draft);
  if ( rolls("choices") ) {
    const tries = new Map();
    const unsettled = new Set();
    // A decision whose answer stopped fitting and which hasn't used up its goes yet.
    // The player's own answers are theirs to fix, never the dice's.
    const redoable = b => staleChoices(b).filter(r => ((tries.get(r.key) ?? 0) < REDO_LIMIT) && !playerOwned(r, stages));
    for ( let guard = 0; guard < maxDecisions; guard++ ) {
      let answered = false;
      let structural = false;
      // First, anything the character has outgrown: drop the answer and let the round below roll it again, from
      // what is on offer now. Each one is given a few goes and then left, so this can't loop for ever.
      const stale = redoable(build);
      if ( stale.length ) {
        for ( const result of stale ) {
          tries.set(result.key, (tries.get(result.key) ?? 0) + 1);
          clearStep(draft, result);
        }
        build = await rebuild(draft);
        continue;
      }
      // Where the dice must wait: a decision of the player's still open, or a shortlist still to be rolled.
      const waitAt = b => Math.min(blockedAt(b, stages), ...b.results
        .filter(r => (r.status === "needsInput") && stageKind(r, config) && !stages[r.key]).map(r => r.at ?? 1));
      // What the dice still owe, up to there.
      const owed = b => openChoices(b).filter(r => !playerOwned(r, stages) && !stageKind(r, config)
        && ((r.at ?? 1) <= waitAt(b)));
      // A shortlist is rolled from a fresh replay with nothing the dice owe at or below its level: then it sees
      // the character exactly as the GM's replay will (a fighting style already taken isn't offered again as a
      // feat). The replay rolls a list again the same way, for a pick the player already made.
      const listReady = result => !answered && !owed(build).some(r => (r !== result) && ((r.at ?? 1) <= (result.at ?? 1)));
      // One character level at a time, the lowest with anything owed: a round then starts from the same
      // character whether the dice roll it in one go (the GM's replay) or in several, a stage at a time.
      // A choice the dice can't settle (nothing allowed in it) doesn't hold up the levels above it.
      const level = Math.min(...owed(build).filter(r => !unsettled.has(r.key)).map(r => r.at ?? 1));
      for ( const result of build.results ) {
        const s = stages[result.key];
        if ( s && !s.options && (s.kind !== "multiclass") ) {
          if ( !listReady(result) ) continue;
          s.options = await rollShortlist(stageCandidates(s.kind, result), stageSize(s.kind, config, free), result.key, roll);
          continue;
        }
        if ( (result.status !== "needsInput") || !ANSWERABLE.includes(result.type) ) continue;
        // Nothing past a decision the player hasn't made yet: what comes later can depend on it.
        if ( (result.at ?? 1) > waitAt(build) ) continue;
        if ( !stageKind(result, config) && ((result.at ?? 1) > level) ) continue;
        if ( playerOwned(result, stages) ) continue;
        const kind = stageKind(result, config);
        if ( kind ) {
          // A stage: roll its shortlist (all of them where the GM says 0, D39) and leave the pick to the player.
          if ( !listReady(result) ) continue;
          stages[result.key] = { kind, path: [...result.path], advancementId: result.advancementId, at: result.at ?? 1,
            options: await rollShortlist(stageCandidates(kind, result), stageSize(kind, config, free), result.key, roll) };
          continue;
        }
        if ( !await rollChoice(draft, result, { roll, feats: config?.feats }) ) {
          unsettled.add(result.key);
          continue;
        }
        answered = true;
        if ( STRUCTURAL.includes(result.type) ) {
          structural = true;
          break;
        }
      }
      if ( !answered ) {
        // Nothing at this level could be settled: on to the next level with anything owed, if there is one.
        if ( owed(build).some(r => !unsettled.has(r.key)) ) continue;
        break;
      }
      build = await rebuild(draft);
      // Round again while anything is open — or a shortlist still to roll, or an answer that stopped fitting.
      const listsLeft = build.results.some(r => (stageKind(r, config) && (r.status === "needsInput") && !stages[r.key])
        || (stages[r.key] && !stages[r.key].options && (stages[r.key].kind !== "multiclass")));
      if ( !structural && !owed(build).length && !listsLeft && !redoable(build).length ) break;
    }
  }
  if ( rolls("equipment") ) {
    // Starting equipment is the first level's: "a warhammer (if proficient)" asks about the proficiencies the
    // character starts with, not those a later class or feat brings. Read from the level-1 character, the kit
    // is the same however many runs the dice take to reach the end, and it is rolled in the first one.
    const atOne = ((draft.level ?? 1) > 1)
      ? await rebuild({ ...draft, level: 1, multiclass: [] }, { reference: true }) : build;
    // Both sources are read at once (each one checks proficiencies); the rolling itself stays in order.
    const contexts = await Promise.all(EQUIPMENT_SOURCES.map(role => equipmentContext(role, atOne)));
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

/**
 * The validator (PLAN 2.6; DESIGN.md → Validation). The wizard runs it before submitting and the active GM
 * runs it on every submission (convention 9: same code, GM authoritative). It never trusts the player's
 * computed values: it rebuilds the character from the recipe and checks every step on that rebuild.
 *
 * Order: envelope (shape, schema, world, rules) → strict rebuild (picks, every advancement step) and the
 * rebuilt character's structure → ability scores (incl. the chat roll, D15) → equipment for both sources
 * (incl. the 2014 wealth roll) → spells → details, portrait, character limit.
 */

import { normalizeUuid } from "../catalog/filters.mjs";
import { buildCharacter, buildInput } from "./build.mjs";
import { checkDraftAbilities } from "./ability-roll.mjs";
import { resolveDraftEquipment } from "./equipment-items.mjs";
import { checkDraftSpells } from "./spell-facts.mjs";
import { checkMulticlassPrerequisites } from "./multiclass.mjs";
import { checkDraftHitPoints } from "./hit-points.mjs";
import { checkEnvelope, checkLevels, checkBuiltStructure, checkDetails, checkPortraitImage, checkCharacterLimit, errorsByStep }
  from "./draft-checks.mjs";

/** A plain summary of a built character for draft-checks.mjs `checkBuiltStructure`. */
export function actorSummary(actor) {
  return {
    level: actor.system.details?.level ?? null,
    hp: actor.system.attributes?.hp?.max ?? null,
    items: actor.items.map(i => ({
      id: i.id, name: i.name, type: i.type,
      source: normalizeUuid(i._stats?.compendiumSource) ?? null,
      origin: i.flags?.dnd5e?.advancementOrigin ?? null,
      levels: i.type === "class" ? i.system.levels : null,
      classIdentifier: i.type === "subclass" ? (i.system.classIdentifier ?? null) : null
    }))
  };
}

/**
 * Validate a draft.
 * @param {object} draft                      As stored (it is migrated first).
 * @param {object} options
 * @param {object} options.catalog            From getCatalog() — for the GM, the player's view of it.
 * @param {string} options.userId             The draft's owner (chat roll records must be theirs).
 * @param {string} [options.worldId]          Default: this world.
 * @param {string} [options.rules]            Default: this world's dnd5e rules version.
 * @param {string[]} [options.allowedMethods] Ability methods the GM allows (PLAN 2.10).
 * @param {object|null} [options.image]       The portrait sent with the submission.
 * @param {{ limit?: number|null, existing?: number }} [options.characters]  Character limit (A4).
 * @param {{ startingLevel?: number, multiclass?: boolean, prerequisites?: boolean }} [options.levels]  What the GM
 *   allows (D32, D35); `levelOptions(readSettings())` gives these and the hit point method.
 * @param {"average"|"rolled"} [options.hitPointMethod]  The GM's hit point method (D33).
 * @returns {Promise<{ ok: boolean, errors: object[], byStep: object[], draft: object|null, built: object|null,
 *   equipment: object|null }>}   `built` / `equipment` are reused to create the actor (PLAN 2.7).
 */
export async function validateDraft(draft, { catalog, standard = null, userId, worldId = game.world.id,
  rules = game.settings.get("dnd5e", "rulesVersion"), allowedMethods, image = null, characters = {}, levels = {},
  hitPointMethod = "average" } = {}) {
  const done = (errors, extra = {}) => ({ ok: !errors.length, errors, byStep: errorsByStep(errors), draft: null, built: null,
    equipment: null, ...extra });

  const envelope = checkEnvelope(draft, { worldId, rules });
  if ( envelope.errors.length ) return done(envelope.errors);
  const d = envelope.draft;

  // Choices: strict replay — every step must be in the recipe (fill: false).
  const built = await buildCharacter(buildInput(d), { catalog, fill: false, hitPointMethod, slice: true });
  const { errors, equipment } = await checkBuilt(d, built, { catalog, standard, userId, allowedMethods, image, characters,
    levels, hitPointMethod });
  return done(errors, { draft: d, built, equipment });
}

/**
 * Every check that works on an already-built character. `validateDraft` calls it after its strict replay; the
 * wizard calls it with the build it already made for the screen, so it doesn't replay the character twice
 * (PLAN 3.2). With a filled build there are no MISSING_STEP errors: unanswered steps are `needsInput` results
 * for the wizard to show, not mistakes.
 * @param {object} draft                    A migrated, well-formed draft.
 * @param {object} built                    From buildCharacter().
 * @returns {Promise<{ errors: object[], equipment: object|null }>}
 */
export async function checkBuilt(draft, built, { catalog, standard = null, userId, allowedMethods, image = null,
  characters = {}, levels = {}, hitPointMethod = "average" } = {}) {
  const errors = [...built.errors, ...checkLevels(draft, levels)];
  // Multiclassing prerequisites, with the scores the character had when each class joined (D35, D37).
  if ( levels.prerequisites !== false ) errors.push(...checkMulticlassPrerequisites(built.joins ?? []));
  // Rolled hit dice, against chat (D33).
  if ( hitPointMethod === "rolled" ) errors.push(...checkDraftHitPoints(draft, built, { userId }));
  const blocked = built.summary.blocked.length || !built.roots.class;
  if ( !blocked ) errors.push(...checkBuiltStructure(actorSummary(built.actor), catalog, expectedClasses(draft)));

  errors.push(...checkDraftAbilities(draft, { userId, allowedMethods }));

  let equipment = null;
  if ( built.roots.class || built.roots.background ) {
    equipment = await resolveDraftEquipment(built, draft, { catalog, userId, standard });
    errors.push(...equipment.errors);
  }
  if ( built.roots.class ) errors.push(...checkDraftSpells(built, draft, { catalog }));

  errors.push(...checkDetails(draft), ...checkPortraitImage(image), ...checkCharacterLimit(characters));
  return { errors: dedupe(errors), equipment };
}

/**
 * The validator's options from the GM's settings (D32–D35): the starting level, multiclassing and its
 * prerequisites, and the hit point method.
 * @param {{ levels: object }} settings   readSettings()
 */
export function levelOptions(settings) {
  const l = settings?.levels ?? {};
  return { levels: { startingLevel: l.startingLevel ?? 1, multiclass: !!l.multiclass, prerequisites: l.prerequisites !== false,
    firstClassLevels: l.firstClassLevels ?? 1 },
    hitPointMethod: l.hitPointMethod ?? "average" };
}

/** The level and classes the built character must have: the draft's (D32, D37). */
export function expectedClasses(draft) {
  const level = draft.level ?? 1;
  const others = draft.multiclass ?? [];
  const first = level - others.reduce((n, m) => n + m.levels, 0);
  return { level, classes: [{ source: normalizeUuid(draft.picks?.class), levels: first },
    ...others.map(m => ({ source: normalizeUuid(m.uuid), levels: m.levels }))] };
}

/** The same error (code + detail) reported twice (e.g. by the rebuild and the structure check) once. */
function dedupe(errors) {
  const seen = new Set();
  return errors.filter(e => {
    const k = `${e.code}|${JSON.stringify(e.detail ?? null)}`;
    if ( seen.has(k) ) return false;
    seen.add(k);
    return true;
  });
}

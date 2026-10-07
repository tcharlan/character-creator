/**
 * The Review step (PLAN 3.9): everything the character will be, what still needs fixing, and the button that
 * sends it to the GM. The summary is read from the rebuilt character — never from what the player typed — so it
 * shows exactly what the GM's side will create.
 */

import { ABILITIES, STATUS } from "../contracts.mjs";
import { errorsByStep } from "../rules/draft-checks.mjs";
import { previewUrl } from "./portrait-step.mjs";

const label = (config, key) => globalThis.CONFIG?.DND5E?.[config]?.[key]?.label ?? key;
const sign = n => (n >= 0 ? `+${n}` : `${n}`);

/**
 * The character as the sheet will show it.
 * @param {number} [goldPerLevel]   The GM's gold for each level above the first (D34), added at creation.
 */
export function summaryOf(built, equipment, draft, { goldPerLevel = 0 } = {}) {
  const actor = built?.actor;
  if ( !actor ) return null;
  const system = actor.system;
  const byType = type => actor.items.filter(i => i.type === type);
  const proficient = (list, config) => Object.entries(list ?? {})
    .filter(([, v]) => v.value > 0).map(([key]) => label(config, key)).sort();

  return {
    name: draft?.details?.name ?? "",
    portrait: previewUrl(draft?.portrait?.pendingImage),
    species: byType("race")[0]?.name ?? null,
    background: byType("background")[0]?.name ?? null,
    // One class by its name; several with their levels, the first class first (D37).
    class: classLine(byType("class"), system.details?.originalClass),
    subclass: byType("subclass").map(i => i.name).join(", ") || null,
    level: system.details?.level ?? 1,
    hitPoints: system.attributes?.hp?.max ?? null,
    armorClass: system.attributes?.ac?.value ?? null,
    speed: system.attributes?.movement?.walk ?? null,
    proficiency: system.attributes?.prof ?? null,
    abilities: ABILITIES.map(key => ({
      key, label: key.toUpperCase(), value: system.abilities?.[key]?.value ?? null,
      modifier: sign(system.abilities?.[key]?.mod ?? 0),
      saveProficient: (system.abilities?.[key]?.proficient ?? 0) > 0
    })),
    skills: proficient(system.skills, "skills"),
    features: byType("feat").map(i => i.name).sort(),
    equipment: (equipment?.items ?? []).map(i => ({ name: i.name ?? i.uuid, count: i.count > 1 ? i.count : null })),
    currency: Object.entries(withLevelGold(equipment?.currency, goldPerLevel, draft?.level)).filter(([, v]) => v > 0)
      .map(([k, v]) => `${v} ${k.toUpperCase()}`).join(", "),
    spells: byType("spell").map(i => i.name).sort()
  };
}

/** "Fighter" for one class; "Fighter 3 / Wizard 2" for several, the first class first. */
function classLine(classes, originalId) {
  if ( !classes.length ) return null;
  if ( classes.length === 1 ) return classes[0].name;
  const sorted = [...classes].sort((a, b) => (a.id === originalId ? -1 : b.id === originalId ? 1 : 0));
  return sorted.map(c => `${c.name} ${c.system?.levels ?? 1}`).join(" / ");
}

/** The equipment's coins plus the GM's gold for each level above the first (D34), as the GM's side adds it. */
function withLevelGold(currency = {}, goldPerLevel = 0, level = 1) {
  const extra = goldPerLevel * Math.max(0, (level ?? 1) - 1);
  return extra ? { ...currency, gp: (currency?.gp ?? 0) + extra } : { ...currency };
}

/**
 * The Review step's model.
 * @param {object} options
 * @param {object} options.built          From buildCharacter().
 * @param {object} options.validation     From the wizard's checks.
 * @param {object} options.draft
 * @param {object} [options.equipment]    Resolved equipment, with names filled in.
 * @param {boolean} [options.busy]        A submission is on its way.
 */
export function reviewModel({ built, validation, draft, equipment, busy = false, another = false, goldPerLevel = 0 }) {
  const errors = validation?.errors ?? [];
  const groups = errorsByStep(errors).map(g => ({
    step: g.step,
    errors: g.errors.map(e => ({ code: e.code, key: e.key }))
  }));
  const status = draft?.status ?? STATUS.DRAFT;
  return {
    summary: summaryOf(built, equipment, draft, { goldPerLevel }),
    groups,
    problems: errors.length,
    ready: !errors.length,
    busy,
    status,
    // Room for another character under the GM's limit (A4), once this one is made.
    another: !!another,
    outcome: outcomeOf(draft)
  };
}

/** What to show once the character has been sent: waiting, created, or refused. */
export function outcomeOf(draft) {
  switch ( draft?.status ) {
    case STATUS.SUBMITTED:
      return { kind: "pending" };
    case STATUS.CREATED:
      return { kind: "created", actorUuid: draft.result?.actorUuid ?? null,
        warnings: (draft.result?.errors ?? []).map(e => e.key) };
    case STATUS.FAILED:
      return { kind: "failed", errors: (draft.result?.errors ?? []).map(e => ({ code: e.code, key: e.key, step: e.step })) };
    default:
      return null;
  }
}

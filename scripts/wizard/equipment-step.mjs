/**
 * The Equipment step (PLAN 3.5): each source's starting equipment as a set of choices — "a or b" groups, category
 * pickers ("any simple weapon"), and the starting-wealth alternative (D23: class and background are separate).
 *
 * The rules live in `rules/equipment.mjs`; this shapes them for the screen and turns a click into a selection.
 */

import { EQUIPMENT_SOURCES, CATEGORY_TYPES, unitCount, listDecisions } from "../rules/equipment.mjs";

export { EQUIPMENT_SOURCES };

const catalogName = (catalog, uuid) => catalog?.get?.(uuid)?.name ?? uuid?.split(".").pop() ?? "";

/** A readable label for a category entry ("Any simple weapon", "Any artisan's tools"). */
export function categoryLabel(type, key) {
  const C = globalThis.CONFIG?.DND5E ?? {};
  const label = C.weaponProficiencies?.[key] ?? C.armorProficiencies?.[key] ?? C.toolProficiencies?.[key]
    ?? C.focusTypes?.[key]?.label ?? C.weaponTypes?.[key] ?? C.armorTypes?.[key] ?? key;
  return typeof label === "string" ? label : (label?.label ?? key);
}

/** What one entry in the tree offers, as a sentence: "Mace", "Any martial weapon ×2", "15 gp", "A and B". */
export function entryLabel(node, catalog) {
  switch ( node.type ) {
    case "linked": {
      const count = unitCount(node);
      return count > 1 ? `${count} × ${catalogName(catalog, node.key)}` : catalogName(catalog, node.key);
    }
    case "currency":
      return `${unitCount(node)} ${String(node.key ?? "gp").toUpperCase()}`;
    case "AND":
      return node.children.map(c => entryLabel(c, catalog)).filter(Boolean).join(", ");
    case "OR":
      return node.children.map(c => entryLabel(c, catalog)).filter(Boolean).join(" / ");
    default: {
      if ( !CATEGORY_TYPES.includes(node.type) ) return "";
      const count = unitCount(node);
      const label = categoryLabel(node.type, node.key);
      return count > 1 ? `${count} × ${label}` : label;
    }
  }
}

/**
 * One source's screen model.
 * @param {object} source
 * @param {"class"|"background"} source.role
 * @param {string} source.name                 The item's name.
 * @param {object} source.tree                 From buildTree().
 * @param {object|null} source.wealthOption    From wealthOption().
 * @param {(node) => string[]} source.candidates
 * @param {(uuid) => boolean} [source.isProficient]
 * @param {object|null} selection              draft.equipment[role]
 * @param {object} catalog
 */
export function sourceModel({ role, name, tree, wealthOption, candidates, isProficient }, selection, catalog) {
  const mode = selection?.mode ?? "items";
  const choices = selection?.choices ?? {};
  const picks = selection?.picks ?? {};
  const decisions = listDecisions(tree, choices).map(d => {
    if ( d.kind === "or" ) {
      return {
        kind: "or", id: d.id,
        options: d.options.map(id => {
          const child = tree.nodes.get(id);
          const needsProficiency = (child.type === "linked") && !!child.requiresProficiency;
          return {
            id, label: entryLabel(child, catalog), selected: choices[d.id] === id,
            warning: !!(needsProficiency && isProficient && !isProficient(child.key))
          };
        })
      };
    }
    const chosen = picks[d.id] ?? [];
    const options = candidates(tree.nodes.get(d.id)).map(uuid => ({ uuid, name: catalogName(catalog, uuid) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      kind: "category", id: d.id, count: d.count, label: categoryLabel(d.type, d.key),
      slots: Array.from({ length: d.count }, (_, i) => ({ index: i, uuid: chosen[i] ?? null, options }))
    };
  });

  const fixed = [...tree.nodes.values()].filter(n => (n.type === "linked") && !n.group).map(n => entryLabel(n, catalog));
  return {
    role, name, mode,
    decisions,
    fixed,
    wealth: wealthOption ? {
      fixed: wealthOption.fixed ?? null,
      formula: wealthOption.formula ?? null,
      rollable: !!wealthOption.number,
      total: selection?.wealth?.total ?? null,
      rolled: !!selection?.wealth?.messageId,
      range: wealthOption.min !== undefined ? [wealthOption.min, wealthOption.max] : null
    } : null,
    complete: mode === "wealth"
      ? !!(wealthOption && (wealthOption.fixed !== undefined || selection?.wealth?.total))
      : decisions.every(d => (d.kind === "or" ? !!choices[d.id] : (picks[d.id] ?? []).filter(Boolean).length === d.count))
  };
}

/* -------------------------------------------- */
/*  Answers                                     */
/* -------------------------------------------- */

const blank = () => ({ mode: "items", choices: {}, picks: {} });

/**
 * Take the items, or the starting wealth (D23: one source at a time). A roll made for this source stays on
 * the draft either way (D26), so switching back to the gold finds the same total and never rolls twice.
 */
export function setMode(draft, role, mode) {
  const current = draft.equipment[role] ?? blank();
  const wealth = current.wealth ? { wealth: current.wealth } : {};
  if ( mode === "wealth" ) draft.equipment[role] = { mode: "wealth", choices: {}, picks: {}, ...wealth };
  else draft.equipment[role] = { mode: "items", choices: current.choices ?? {}, picks: current.picks ?? {}, ...wealth };
  return draft;
}

/** Choose one branch of an "a or b" group; picks below the branch that's no longer taken are dropped. */
export function chooseBranch(draft, role, entryId, optionId, tree) {
  const selection = draft.equipment[role] ?? blank();
  const choices = { ...selection.choices, [entryId]: optionId };
  const picks = { ...selection.picks };
  // Anything no longer reachable is dropped, so a stale pick can't sit in the draft.
  const reachable = new Set(listDecisions(tree, choices).map(d => d.id));
  for ( const id of Object.keys(picks) ) if ( !reachable.has(id) ) delete picks[id];
  for ( const id of Object.keys(choices) ) if ( !reachable.has(id) && (id !== entryId) ) delete choices[id];
  draft.equipment[role] = { ...selection, mode: "items", choices, picks };
  return draft;
}

/** Put an item in one slot of a category pick ("any simple weapon"). */
export function setPick(draft, role, entryId, index, uuid) {
  const selection = draft.equipment[role] ?? blank();
  const list = [...(selection.picks?.[entryId] ?? [])];
  while ( list.length <= index ) list.push(null);
  list[index] = uuid || null;
  const picks = { ...selection.picks, [entryId]: list.filter(v => v !== null) };
  draft.equipment[role] = { ...selection, mode: "items", picks };
  return draft;
}

/** Record a rolled starting-wealth total (the roll itself is posted to chat by equipment-items.mjs). */
export function setWealth(draft, role, wealth) {
  const selection = draft.equipment[role] ?? blank();
  draft.equipment[role] = { ...selection, mode: "wealth", choices: {}, picks: {}, wealth };
  return draft;
}

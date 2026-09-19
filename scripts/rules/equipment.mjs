/**
 * Starting equipment (PLAN 2.5, from spike 1.6). Pure: no Foundry globals, so the wizard, the GM's
 * validator and the unit tests share it. `equipment-items.mjs` is the Foundry side (candidates from the
 * catalog, proficiency, creation data, the 2014 wealth roll).
 *
 * Reads dnd5e's `system.startingEquipment` (a flat list of EquipmentEntryData linked by `group`) plus
 * `system.wealth`; the rules content comes from the item data, this only reads its structure (dnd5e has
 * no resolver — RESEARCH.md → Spike 1.6).
 *
 * Entry types (dnd5e 5.3.3): AND, OR (grouping); linked (key = item UUID); weapon / armor / tool / focus
 * (key = category key, choose `count` items); currency (key, count = amount).
 *
 * Selection, one per source item (D23: class and background are independent):
 *   { mode: "items" | "wealth",
 *     choices: { [orEntryId]: chosenChildEntryId },
 *     picks:   { [categoryEntryId]: [uuid, ...] },      // one UUID per unit of `count`
 *     wealth?: { total, messageId }                    // wealth mode with a dice formula (2014, rolled, D15)
 *   }
 */

import { makeError } from "../contracts.mjs";

export const GROUPING = Object.freeze(["AND", "OR"]);
export const CATEGORY_TYPES = Object.freeze(["weapon", "armor", "tool", "focus"]);
export const ENTRY_TYPES = Object.freeze([...GROUPING, ...CATEGORY_TYPES, "linked", "currency"]);
export const EQUIPMENT_SOURCES = Object.freeze(["class", "background"]);

/** Build a tree from the flat entry list. Top-level entries have an empty or null `group`. */
export function buildTree(entries = []) {
  const nodes = new Map(entries.map(e => [e._id, { ...e, children: [] }]));
  const roots = [];
  for ( const node of nodes.values() ) {
    const parent = node.group ? nodes.get(node.group) : null;
    (parent ? parent.children : roots).push(node);
  }
  const bySort = (a, b) => (a.sort ?? 0) - (b.sort ?? 0);
  for ( const node of nodes.values() ) node.children.sort(bySort);
  roots.sort(bySort);
  return { _id: "__root", type: "AND", children: roots, nodes };
}

/** Units an entry grants or asks for (dnd5e: an empty count means 1). */
export const unitCount = node => (Number.isInteger(node.count) && node.count > 0 ? node.count : 1);

/**
 * Wealth offered by the item: `{ fixed }` for a plain number (2024: "or 155 GP"); for a simple dice formula
 * "XdY" or "XdY * Z" (2014 rolled wealth) `{ formula, number, faces, multiplier, min, max }`; `{ formula }`
 * if unrecognised; or null.
 */
export function wealthOption(wealth) {
  const w = String(wealth ?? "").trim();
  if ( !w ) return null;
  if ( /^\d+$/.test(w) ) return { fixed: Number(w) };
  const m = w.match(/^(\d+)d(\d+)\s*(?:[*x×]\s*(\d+))?$/i);
  if ( m ) {
    const [number, faces, multiplier] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 1)];
    return { formula: w, number, faces, multiplier, min: number * multiplier, max: number * faces * multiplier };
  }
  return { formula: w };
}

/**
 * The decisions a player must make, given the choices made so far (only reachable branches).
 * @returns {{ id, kind: "or"|"category", options?: string[], type?, key?, count? }[]}
 */
export function listDecisions(tree, choices = {}) {
  const out = [];
  const walk = node => {
    if ( node.type === "OR" ) {
      out.push({ id: node._id, kind: "or", options: node.children.map(c => c._id) });
      const chosen = node.children.find(c => c._id === choices[node._id]);
      if ( chosen ) walk(chosen);
    } else if ( node.type === "AND" ) {
      node.children.forEach(walk);
    } else if ( CATEGORY_TYPES.includes(node.type) ) {
      out.push({ id: node._id, kind: "category", type: node.type, key: node.key, count: unitCount(node) });
    }
  };
  walk(tree);
  return out;
}

/**
 * Resolve a selection into items and currency, validating it. For a rolled wealth total only the range is
 * checked here; the chat record is checked by equipment-items.mjs.
 * @param {object} tree                  From buildTree().
 * @param {string|null} wealth           The item's `system.wealth`.
 * @param {object} selection             See the header.
 * @param {object} ctx
 * @param {(node, uuid) => boolean} ctx.inCategory    Is this UUID an allowed member of the category entry?
 * @param {(uuid) => boolean} [ctx.isProficient]      For `requiresProficiency` linked entries.
 * @param {(uuid) => boolean} [ctx.isAllowed]         Is a linked item allowed (catalog)? Default: yes.
 * @returns {{ items: {uuid, count, entryId}[], currency: Record<string, number>, errors: object[] }}
 *   errors are makeError() objects with `detail.entryId` where an entry is at fault.
 */
export function resolveSelection(tree, wealth, selection = {}, ctx = {}) {
  const items = [];
  const currency = {};
  const errors = [];
  const fail = (code, entryId = null, detail) => {
    errors.push(makeError(code, { entryId, ...(detail === undefined ? {} : { value: detail }) }));
  };
  const mode = selection?.mode ?? "items";

  // Unknown entry types anywhere in the data block the step (never silently skipped).
  for ( const node of tree.nodes.values() ) {
    if ( !ENTRY_TYPES.includes(node.type) ) fail("UNKNOWN_ENTRY_TYPE", node._id, node.type);
  }

  if ( mode === "wealth" ) {
    const option = wealthOption(wealth);
    if ( !option ) fail("NO_WEALTH_OPTION");
    else if ( "fixed" in option ) currency.gp = option.fixed;
    else {
      const total = selection.wealth?.total;
      const ok = Number.isInteger(total) && option.min !== undefined && total >= option.min && total <= option.max;
      if ( !ok ) fail("WEALTH_OUT_OF_RANGE", null, { total: total ?? null, min: option.min ?? null, max: option.max ?? null });
      else currency.gp = total;
    }
    if ( Object.keys(selection.choices ?? {}).length || Object.keys(selection.picks ?? {}).length ) {
      fail("UNEXPECTED_SELECTION", null, "choices or picks in wealth mode");
    }
    return { items, currency, errors };
  }
  if ( mode !== "items" ) {
    fail("BAD_MODE", null, mode);
    return { items, currency, errors };
  }
  if ( selection?.wealth ) fail("UNEXPECTED_SELECTION", null, "wealth in items mode");

  const reached = new Set();
  const walk = node => {
    reached.add(node._id);
    switch ( node.type ) {
      case "AND":
        node.children.forEach(walk);
        break;
      case "OR": {
        const choiceId = selection.choices?.[node._id];
        if ( !choiceId ) return fail("MISSING_CHOICE", node._id);
        const chosen = node.children.find(c => c._id === choiceId);
        if ( !chosen ) return fail("INVALID_CHOICE", node._id, choiceId);
        walk(chosen);
        break;
      }
      case "linked":
        if ( ctx.isAllowed && !ctx.isAllowed(node.key) ) return fail("INVALID_CHOICE", node._id, node.key);
        if ( node.requiresProficiency && ctx.isProficient && !ctx.isProficient(node.key) ) {
          return fail("NOT_PROFICIENT", node._id, node.key);
        }
        items.push({ uuid: node.key, count: unitCount(node), entryId: node._id });
        break;
      case "currency":
        currency[node.key] = (currency[node.key] ?? 0) + unitCount(node);
        break;
      default:
        if ( CATEGORY_TYPES.includes(node.type) ) {
          const picks = selection.picks?.[node._id] ?? [];
          if ( picks.length !== unitCount(node) ) {
            return fail("WRONG_PICK_COUNT", node._id, { picks: picks.length, needed: unitCount(node) });
          }
          const bad = picks.filter(u => !ctx.inCategory?.(node, u));
          if ( bad.length ) return fail("NOT_IN_CATEGORY", node._id, bad);
          for ( const uuid of picks ) items.push({ uuid, count: 1, entryId: node._id });
        }
    }
  };
  walk(tree);

  // Choices or picks for entries that aren't reached (unchosen branches, made-up ids) are tampering.
  for ( const id of [...Object.keys(selection.choices ?? {}), ...Object.keys(selection.picks ?? {})] ) {
    if ( !reached.has(id) ) fail("UNEXPECTED_SELECTION", id);
  }
  return { items: mergeItems(items), currency, errors };
}

/** Merge identical UUIDs (e.g. two picks of the same weapon) into one line with a summed count. */
function mergeItems(items) {
  const byUuid = new Map();
  for ( const it of items ) {
    const prev = byUuid.get(it.uuid);
    if ( prev ) prev.count += it.count;
    else byUuid.set(it.uuid, { ...it });
  }
  return [...byUuid.values()];
}

/** Add currency amounts into a total (in place); returns the total. */
export function addCurrency(total, add) {
  for ( const [k, v] of Object.entries(add ?? {}) ) total[k] = (total[k] ?? 0) + v;
  return total;
}

/**
 * A default selection: in every OR, the first usable option (linked items the character is proficient
 * with, categories with candidates); the first `count` candidates of every category. Also the D4
 * auto-select model: an OR with one usable option, a category with exactly `count` candidates.
 * @param {object} tree
 * @param {object} options
 * @param {(node) => string[]} options.candidates   Allowed UUIDs for a category entry.
 * @param {(uuid) => boolean} [options.isProficient]
 * @param {(uuid) => boolean} [options.isAllowed]
 */
export function defaultSelection(tree, { candidates = () => [], isProficient, isAllowed } = {}) {
  const selection = { mode: "items", choices: {}, picks: {} };
  const usable = node => {
    if ( node.type === "linked" ) {
      return (!isAllowed || isAllowed(node.key)) && (!node.requiresProficiency || !isProficient || isProficient(node.key));
    }
    if ( CATEGORY_TYPES.includes(node.type) ) return candidates(node).length >= 1;
    if ( node.type === "AND" ) return node.children.every(usable);
    if ( node.type === "OR" ) return node.children.some(usable);
    return true;
  };
  const walk = node => {
    if ( node.type === "OR" ) {
      const chosen = node.children.find(usable) ?? node.children[0];
      if ( !chosen ) return;
      selection.choices[node._id] = chosen._id;
      walk(chosen);
    } else if ( node.type === "AND" ) node.children.forEach(walk);
    else if ( CATEGORY_TYPES.includes(node.type) ) {
      const c = candidates(node);
      selection.picks[node._id] = Array.from({ length: unitCount(node) }, (_, i) => c[i % Math.max(c.length, 1)]).filter(Boolean);
    }
  };
  walk(tree);
  return selection;
}
